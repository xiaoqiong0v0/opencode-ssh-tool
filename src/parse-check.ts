// 发送前语法预检（只解析、绝不执行命令）：
// - PowerShell：常驻解析侧车（优先 pwsh 7，回落 Windows PowerShell 5.1）。命令文本一律
//   base64(UTF-8) 传输，解析器返回结构化 ErrorId + 起止行/列 + 出错片段（Extent.Text 也 base64）。
// - bash/zsh：每次 spawn `bash -n`/`zsh -n` 作粗闸门（只给行号、无语言无关 ErrorId），钉 LC_ALL=C。
// - 不支持的 shell，或解析器不可用/超时/崩溃：一律返回 { ok: true }（不支持就不拦，绝不误拦）。
//
// 关键实测约束（见 .tmp/scratch/probe-precheck-20261016.md）：
// 1) 判定只看 errorCount>0；IncompleteInput 对截断单行恒 true，不能当闸门。
// 2) 命令文本/片段不可做任何归一化——字符串内 `$(...)` 的子表达式错误会被检出，归一化会漏报。
// 3) 侧车脚本必须 ASCII-only：5.1 读无 BOM 的 UTF-8 脚本会按 ANSI 解码，含非 ASCII 会把脚本自身解析炸掉；
//    非 ASCII 数据只经 base64 进出。此处改用 -EncodedCommand（UTF-16LE base64），同样只含 ASCII 字符。
// 4) 侧车必须常驻（一次性启动 0.6~1.4s，之后每条往返 0~1ms；每条冷启动约 1s，不可接受）。

import { spawn, type ChildProcess } from "node:child_process"

export type ParseIssue = { errorId: string; line: number; col: number; text: string }
export type ParseCheckResult = { ok: true } | { ok: false; errors: ParseIssue[] }

/** 通过结果的共享单例（无错误时复用，语义明确且避免重复分配） */
const PASS: ParseCheckResult = { ok: true }

/** 侧车启动超时（毫秒）：pwsh 7 实测 ~0.6s、5.1 ~1.4s，留足余量；超时即换下一个候选 */
const SIDECAR_START_TIMEOUT_MS = 5_000

/** 单次解析请求往返超时（毫秒）：实测 0~1ms；超时视为侧车异常，杀进程并降级放行 */
const SIDECAR_REQUEST_TIMEOUT_MS = 5_000

/** 侧车运行中崩溃后允许的自动重启次数：超过则本会话内永久降级为放行 */
const SIDECAR_MAX_RESTARTS = 1

/** bash/zsh 预检超时（毫秒）：`-n` 纯解析不执行，正常 <50ms；超时按放行处理 */
const POSIX_CHECK_TIMEOUT_MS = 10_000

/** bash/zsh 错误消息中的行号（英文 `line 2` / 中文 `行 2`）；解析不到时回退第 1 行 */
const POSIX_LINE_RE = /(?:line|行)\s*(\d+)/

/** bash 粗错误的固定 ErrorId（bash 无语言无关 ErrorId，仅作占位标记） */
const BASH_ERR_ID = "bash-syntax"

/**
 * POSIX 语法错误消息特征（LC_ALL=C 英文；bash/zsh 措辞不随版本稳定，故只做"是否像语法错误"的存在性判断）：
 * 用于把「命令不存在 / WSL 无发行版」等**非语法错误**的失败（如 exit 127）与真语法错误区分开——
 * 前者必须放行，绝不误拦。
 */
const POSIX_SYNTAX_RE = /(syntax error|unexpected EOF|unexpected end of file|parse error|语法错误|未预期的记号|未预期的文件结尾)/i

/** PowerShell 侧车候选解释器（按优先级）：Windows 上优先 pwsh 7，回落 5.1；非 Windows 仅 pwsh */
const PS_CANDIDATES: readonly string[] =
  process.platform === "win32" ? ["pwsh", "powershell.exe"] : ["pwsh"]

/**
 * PowerShell 常驻侧车脚本（**必须 ASCII-only**，见文件头约束 3）。
 * 协议：父写一行 base64(UTF-8 命令文本) → 子回一行 `ERRCOUNT=<n>[|ErrorId:line:col:b64(text)]...`；
 * 首行 `READY` 表示就绪；收 `!QUIT` 或 stdin EOF 即干净退出（`!` 不是 base64 字符，避免 payload 碰撞）。
 * 输出行整体为 ASCII（ErrorId 为 ASCII、片段走 base64），故不受控制台代码页影响。
 */
const PS_SIDECAR_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "$out = [Console]::Out",
  "$out.WriteLine('READY')",
  "$out.Flush()",
  "while ($true) {",
  "  $line = [Console]::In.ReadLine()",
  "  if ($null -eq $line) { break }",
  "  if ($line -eq '!QUIT') { break }",
  "  try {",
  "    $bytes = [Convert]::FromBase64String($line)",
  "    $text = [System.Text.Encoding]::UTF8.GetString($bytes)",
  "    $tokens = $null",
  "    $errors = $null",
  "    [void][System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$errors)",
  "    if ($null -eq $errors) { $errors = @() }",
  "    $sb = New-Object System.Text.StringBuilder",
  "    [void]$sb.Append('ERRCOUNT=').Append($errors.Count)",
  "    foreach ($e in $errors) {",
  "      $tb = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($e.Extent.Text))",
  "      [void]$sb.Append('|').Append($e.ErrorId).Append(':').Append($e.Extent.StartLineNumber).Append(':').Append($e.Extent.StartColumnNumber).Append(':').Append($tb)",
  "    }",
  "    $out.WriteLine($sb.ToString())",
  "    $out.Flush()",
  "  } catch {",
  "    $out.WriteLine('ERROR=1')",
  "    $out.Flush()",
  "  }",
  "}",
].join("\n")

/**
 * 侧车脚本的 `-EncodedCommand` 参数（UTF-16LE base64，纯 ASCII）。
 * 远程 pwsh 预检直接复用该参数在远端启动同一份侧车脚本，保证协议完全一致。
 */
export const PS_SIDECAR_ENCODED_COMMAND: string = encodeUtf16leBase64(PS_SIDECAR_SCRIPT)

/** 侧车启动参数：-EncodedCommand 传脚本，规避引号与代码页问题（脚本 ASCII-only） */
const PS_SIDECAR_ARGS: readonly string[] = [
  "-NoProfile",
  "-NonInteractive",
  "-NoLogo",
  "-EncodedCommand",
  PS_SIDECAR_ENCODED_COMMAND,
]

/**
 * bash/zsh 运行候选（按序尝试）：本机无 bash 时回落 WSL 里的 bash。
 * 不为 zsh 配 WSL 回落——发行版多半没装 zsh，`wsl zsh -n` 会以"命令不存在"失败，
 * 易被误当成语法错误而**误拦**合法命令；zsh 本机不可用即放行。
 */
const POSIX_RUNNERS: Record<"bash" | "zsh", readonly (readonly string[])[]> = {
  bash: [["bash", "-n"], ["wsl", "bash", "-n"]],
  zsh: [["zsh", "-f", "-n"]],
}

/**
 * 发送前校验命令语法（不执行命令）。
 * @param shell 目标 shell 标识（pwsh/powershell → PowerShell；bash/zsh → `-n`；含 wsl 视为 bash 走 WSL）
 * @param text 待校验的命令文本（原样，不做任何归一化）
 * @returns 通过 `{ok:true}`；有语法错误 `{ok:false, errors}`；不支持或解析器不可用一律 `{ok:true}`
 */
export async function validateCommand(shell: string, text: string): Promise<ParseCheckResult> {
  if (!text) return PASS
  const kind = classifyShell(shell)
  if (kind === "pwsh") {
    const errors = await pwshSidecar.check(text)
    if (errors === null || errors.length === 0) return PASS
    return { ok: false, errors }
  }
  if (kind === "bash" || kind === "zsh") {
    const issue = await checkPosix(kind, text)
    return issue ? { ok: false, errors: [issue] } : PASS
  }
  return PASS
}

/** UTF-16LE + base64 编码（供 `-EncodedCommand` 使用） */
function encodeUtf16leBase64(s: string): string {
  return Buffer.from(s, "utf16le").toString("base64")
}

/**
 * 把命令文本编码为侧车协议请求行（base64(UTF-8)，单行不含换行）。
 * 本地常驻侧车与远程 pwsh 预检共用，保证 payload 格式一致。
 * @param text 待解析的命令文本
 * @returns base64(UTF-8) 字符串
 */
export function encodePwshSidecarPayload(text: string): string {
  return Buffer.from(text, "utf8").toString("base64")
}

/** 把 shell 标识归类：仅识别 PowerShell 与 bash/zsh；其余归为 other（放行） */
function classifyShell(shell: string): "pwsh" | "bash" | "zsh" | "other" {
  const s = shell.trim().toLowerCase()
  if (s.includes("pwsh") || s.includes("powershell")) return "pwsh"
  if (s.includes("zsh")) return "zsh"
  if (s.includes("bash") || s.includes("wsl")) return "bash"
  return "other"
}

/**
 * bash/zsh 粗闸门：按候选顺序 spawn `-n` 解析（不执行）。
 * 首个二进制可用的候选给出结果：exit 0 → 通过；确为语法错误 → 返回一条粗错误。
 * 「非语法错误的失败」（命令不存在/无发行版等，如 exit 127）与候选全部不可用/超时 → 返回 null（放行）。
 * @param kind "bash" | "zsh"
 * @param text 命令文本
 * @returns 语法错误条目；通过或不可用时为 null
 */
async function checkPosix(kind: "bash" | "zsh", text: string): Promise<ParseIssue | null> {
  for (const argv of POSIX_RUNNERS[kind]) {
    const outcome = await runPosixCheck(argv, text)
    if (outcome === null) continue // 二进制不存在/超时：试下一个候选
    if (outcome.code === 0) return null
    // 只有 stderr 确实像语法错误才拦：不能单凭 exit=2（包装脚本/WSL 异常也可能返回 2）；
    // 其余非 0（如 127 command not found、WSL 无发行版）视为"不可用"→ 放行，绝不误拦
    if (!looksLikePosixSyntaxError(outcome.stderr)) return null
    const stderr = outcome.stderr.trim()
    return { errorId: BASH_ERR_ID, line: parsePosixSyntaxLine(outcome.stderr), col: 0, text: stderr }
  }
  return null
}

/**
 * 运行一次 `bash -n`/`zsh -n`：把命令文本经 **stdin** 喂入（规避命令行引号/换行问题），
 * 钉 LC_ALL/LANG=C 保证消息为英文（bash 消息会按 locale 本地化，不可机读），捕获退出码与 stderr。
 * @param argv 完整 argv（如 ["bash","-n"] / ["wsl","bash","-n"]）
 * @param text 命令文本（内部补尾换行，与实际提交语义一致）
 * @returns 正常结束的退出码与 stderr；二进制不可用/超时返回 null
 */
function runPosixCheck(
  argv: readonly string[],
  text: string,
): Promise<{ code: number; stderr: string } | null> {
  return new Promise((resolve) => {
    let proc: ChildProcess
    try {
      // 清掉 BASH_ENV/ENV：否则用户启动文件里的语法错误会让 `bash -n` 把**所有**合法命令判错
      const env = { ...process.env, LC_ALL: "C", LANG: "C" } as NodeJS.ProcessEnv
      delete env.BASH_ENV
      delete env.ENV
      proc = spawn(argv[0], argv.slice(1), {
        stdio: ["pipe", "ignore", "pipe"],
        env,
        windowsHide: true,
      })
    } catch {
      resolve(null)
      return
    }
    let stderr = ""
    let settled = false
    let timer: ReturnType<typeof setTimeout>
    const done = (v: { code: number; stderr: string } | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(v)
    }
    proc.stderr?.setEncoding("utf8")
    proc.stderr?.on("data", (chunk: string) => {
      stderr += chunk
    })
    // 子进程在写入前/写入中退出时，流层会发 EPIPE；无监听会变成未捕获异常。
    // 这里一律视为该候选不可用（结束本次校验，由调用方降级放行）。
    proc.stdin?.on("error", () => done(null))
    proc.stdout?.on("error", () => done(null))
    proc.stderr?.on("error", () => done(null))
    proc.once("error", () => done(null)) // ENOENT 等：该候选不可用
    proc.once("close", (code) => done({ code: code ?? 1, stderr }))
    timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        /* ignore */
      }
      done(null)
    }, POSIX_CHECK_TIMEOUT_MS)
    try {
      proc.stdin?.end(text + "\n")
    } catch {
      /* ignore：close/error 会给出结果 */
    }
  })
}

/**
 * 判断 stderr 是否"像"POSIX shell 语法错误（供本地 `-n` 与远程独立 exec channel 共用）。
 * 只做存在性判断：非语法失败（命令不存在/无发行版等）必须放行，绝不误拦。
 * @param stderr 解析器的标准错误输出
 * @returns 命中语法错误特征时为 true
 */
export function looksLikePosixSyntaxError(stderr: string): boolean {
  return POSIX_SYNTAX_RE.test(stderr)
}

/**
 * 从 bash/zsh 错误消息解析行号；兼容英文 `line N` 与中文 `行 N`。
 * @param stderr 解析器的标准错误输出
 * @returns 行号（解析不到或非正数时回退 1）
 */
export function parsePosixSyntaxLine(stderr: string): number {
  const m = POSIX_LINE_RE.exec(stderr)
  const n = m ? Number.parseInt(m[1], 10) : Number.NaN
  return Number.isFinite(n) && n > 0 ? n : 1
}

/**
 * 解析侧车响应行 `ERRCOUNT=<n>[|ErrorId:line:col:b64]...`。
 * 本地常驻侧车与远程 pwsh 预检共用；远程拿到的 stdout 可能含 `READY`/CRLF，调用方需先取出响应行。
 * @param line 协议响应行（以 `ERRCOUNT=` 开头）
 * @returns 错误列表（空数组=通过）；行格式不合法返回 null
 */
export function parsePwshSidecarResponse(line: string): ParseIssue[] | null {
  const prefix = "ERRCOUNT="
  if (!line.startsWith(prefix)) return null
  const head = line.indexOf("|")
  const countText = head < 0 ? line.slice(prefix.length) : line.slice(prefix.length, head)
  const count = Number.parseInt(countText, 10)
  if (!Number.isFinite(count)) return null
  const errors: ParseIssue[] = []
  if (head >= 0) {
    for (const seg of line.slice(head + 1).split("|")) {
      const issue = parsePsEntry(seg)
      if (issue) errors.push(issue)
    }
  }
  // errorCount>0 但条目未解出时的防御：仍判为有错（不放过确实存在的语法错误）
  if (errors.length === 0 && count > 0) errors.push({ errorId: "ParseError", line: 0, col: 0, text: line })
  return errors
}

/** 解析单条侧车错误条目 `ErrorId:line:col:b64(text)`（b64 不含 `:`，故按前 3 个冒号切分） */
function parsePsEntry(seg: string): ParseIssue | null {
  const c1 = seg.indexOf(":")
  const c2 = seg.indexOf(":", c1 + 1)
  const c3 = seg.indexOf(":", c2 + 1)
  if (c1 < 0 || c2 < 0 || c3 < 0) return null
  return {
    errorId: seg.slice(0, c1),
    line: toInt(seg.slice(c1 + 1, c2)),
    col: toInt(seg.slice(c2 + 1, c3)),
    text: Buffer.from(seg.slice(c3 + 1), "base64").toString("utf8"),
  }
}

/** 十进制解析；非法返回 0 */
function toInt(s: string): number {
  const n = Number.parseInt(s, 10)
  return Number.isFinite(n) ? n : 0
}

/** 可 ref/unref 的流（Node 管道底层为 Socket，TS 的 Readable/Writable 未声明这两个方法） */
interface RefableStream {
  ref?: () => void
  unref?: () => void
}

/** 待决解析请求：写入侧车后等一行响应 */
interface Pending {
  resolve: (line: string) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * 常驻 PowerShell 解析侧车（进程内单例，懒启动、崩溃自愈、空闲不阻塞父进程退出）。
 * 请求按到达顺序排队：协议本就是"一行请求 → 一行响应"，故响应顺序与请求顺序一致。
 */
class PwshSidecar {
  private _proc: ChildProcess | null = null
  private _ready = false
  private _disabled = false
  private _crashes = 0
  /** 挂接代次：新进程挂接后递增，旧进程迟到的 data/exit 一律忽略，防串扰新进程队列 */
  private _attachEpoch = 0
  private _starting: Promise<boolean> | null = null
  private _queue: Pending[] = []
  private _buf = ""

  /**
   * 解析一段命令文本。
   * @param text 命令文本
   * @returns 解析错误列表（空数组=通过）；侧车不可用/异常时返回 null（调用方降级放行）
   */
  async check(text: string): Promise<ParseIssue[] | null> {
    const proc = await this._ensure()
    if (proc === null) return null
    const payload = encodePwshSidecarPayload(text)
    let response: string
    try {
      response = await this._request(proc, payload)
    } catch {
      return null // 侧车异常/超时 → 降级放行
    }
    return parsePwshSidecarResponse(response)
  }

  /**
   * 取得就绪的侧车进程；不可用（找不到解释器）/已达重启上限时返回 null。
   * 懒启动：首次调用才 spawn；并发启动共享同一 Promise（只起一个进程）。
   */
  private async _ensure(): Promise<ChildProcess | null> {
    if (this._disabled) return null
    if (this._proc !== null && this._ready) return this._proc
    if (this._starting === null) this._starting = this._start()
    const ok = await this._starting
    this._starting = null
    return ok ? this._proc : null
  }

  /** 按候选顺序尝试启动；全部失败则永久降级。成功后置空闲不阻塞退出（崩溃计数在成功响应后重置） */
  private async _start(): Promise<boolean> {
    for (const bin of PS_CANDIDATES) {
      const proc = await this._spawnCandidate(bin)
      if (proc === null) continue
      // READY 之后、赋值前已退出：不要装入死进程（否则 _ensure 会一直返回它并等超时）
      if (!this._ready) {
        try {
          proc.kill()
        } catch {
          /* ignore */
        }
        continue
      }
      this._proc = proc
      this._unref(proc)
      return true
    }
    this._disabled = true
    return false
  }

  /**
   * 启动一个候选解释器并等待首行 `READY`。
   * @param bin 二进制名（PATH 解析）
   * @returns 就绪的进程；spawn 失败/早退/超时返回 null
   */
  private _spawnCandidate(bin: string): Promise<ChildProcess | null> {
    return new Promise((resolve) => {
      let proc: ChildProcess
      try {
        proc = spawn(bin, PS_SIDECAR_ARGS, {
          stdio: ["pipe", "pipe", "ignore"],
          windowsHide: true,
        })
      } catch {
        resolve(null)
        return
      }
      let settled = false
      let timer: ReturnType<typeof setTimeout>
      const onError = (): void => done(false)
      const onFailExit = (): void => done(false)
      const done = (ok: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        proc.removeListener("error", onError)
        proc.removeListener("exit", onFailExit)
        if (!ok) {
          try {
            proc.kill()
          } catch {
            /* ignore */
          }
        }
        resolve(ok ? proc : null)
      }
      proc.once("error", onError)
      proc.once("exit", onFailExit)
      timer = setTimeout(() => done(false), SIDECAR_START_TIMEOUT_MS)
      this._attach(proc, () => done(true))
    })
  }

  /** 挂接侧车输出：按行解析（首行 READY 触发就绪回调，其后逐行兑现队首请求），并注册退出清理 */
  private _attach(proc: ChildProcess, onReady: () => void): void {
    const epoch = ++this._attachEpoch
    this._buf = ""
    this._ready = false
    const current = (): boolean => epoch === this._attachEpoch
    // 侧车提前退出/管道断开时的流级异常：走统一退出清理（拒绝待决请求，下次调用重新拉起）；
    // 不监听会变成未捕获 EPIPE。旧进程的异常/退出由 epoch 过滤，不污染新进程。
    proc.stdin?.on("error", () => { if (current()) this._onExit(proc) })
    proc.stdout?.on("error", () => { if (current()) this._onExit(proc) })
    proc.stderr?.on("error", () => { if (current()) this._onExit(proc) })
    proc.stdout?.setEncoding("utf8")
    proc.stdout?.on("data", (chunk: string) => {
      if (!current()) return
      this._buf += chunk
      let idx: number
      while ((idx = this._buf.indexOf("\n")) >= 0) {
        const line = this._buf.slice(0, idx).replace(/\r$/, "")
        this._buf = this._buf.slice(idx + 1)
        if (!this._ready) {
          if (line === "READY") {
            this._ready = true
            onReady()
          }
          continue
        }
        const pending = this._queue.shift()
        if (pending) {
          clearTimeout(pending.timer)
          // 成功响应才重置连续崩溃计数：避免 _start 每次都清零导致重启上限失效
          this._crashes = 0
          pending.resolve(line)
        }
        if (this._queue.length === 0) this._unref(proc)
      }
    })
    proc.once("exit", () => { if (current()) this._onExit(proc) })
  }

  /** 侧车退出：运行中崩溃计入重启次数（超限永久降级），并拒绝所有待决请求 */
  private _onExit(proc: ChildProcess): void {
    // 旧进程迟到退出：新进程已接管，忽略，避免清掉新进程的 _ready/队列
    if (this._proc !== null && this._proc !== proc) return
    if (this._proc === proc) {
      if (this._ready) {
        this._crashes += 1
        if (this._crashes > SIDECAR_MAX_RESTARTS) this._disabled = true
      }
      this._proc = null
      this._ready = false
      this._buf = ""
    }
    const err = new Error("pwsh sidecar exited")
    while (this._queue.length > 0) {
      const pending = this._queue.shift()!
      clearTimeout(pending.timer)
      pending.reject(err)
    }
  }

  /**
   * 发送一行请求并等待一行响应。
   * @param proc 就绪的侧车进程
   * @param payload base64(UTF-8 命令文本)
   * @returns 响应行；超时/写失败时 reject（调用方降级放行）
   */
  private _request(proc: ChildProcess, payload: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let pending: Pending
      const timer = setTimeout(() => {
        const i = this._queue.indexOf(pending)
        if (i >= 0) this._queue.splice(i, 1)
        try {
          proc.kill()
        } catch {
          /* ignore */
        }
        reject(new Error("pwsh sidecar request timeout"))
      }, SIDECAR_REQUEST_TIMEOUT_MS)
      pending = { resolve, reject, timer }
      this._queue.push(pending)
      this._ref(proc)
      try {
        proc.stdin?.write(payload + "\n")
      } catch {
        const i = this._queue.indexOf(pending)
        if (i >= 0) this._queue.splice(i, 1)
        clearTimeout(pending.timer)
        reject(new Error("pwsh sidecar write failed"))
      }
    })
  }

  /** 请求期间保持事件循环引用，确保极简进程里也能等到响应 */
  private _ref(proc: ChildProcess): void {
    proc.ref()
    refStream(proc.stdin)
    refStream(proc.stdout)
  }

  /** 空闲时解除引用：侧车不阻止父进程正常退出（父退出→管道关闭→侧车自退） */
  private _unref(proc: ChildProcess): void {
    proc.unref()
    unrefStream(proc.stdin)
    unrefStream(proc.stdout)
  }
}

/** 解除某流的引用（尽力而为） */
function unrefStream(s: unknown): void {
  ;(s as RefableStream | null)?.unref?.()
}

/** 恢复某流的引用（尽力而为） */
function refStream(s: unknown): void {
  ;(s as RefableStream | null)?.ref?.()
}

/** 进程内单例侧车 */
const pwshSidecar = new PwshSidecar()
