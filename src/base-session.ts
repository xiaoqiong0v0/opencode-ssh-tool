// BaseSession：SSH(SshSession) 与本地(LocalSession) 终端的公共基类
// 统一完成标记法：注入 PROMPT_COMMAND 脚本，命令完成时输出 <SSH_DONE:退出码>
// 子类仅需实现：连接建立(connect)、数据写入(_write)、传输层清理(_closeTransport)、状态字段(getStatus)

import {
  ANIMATION_WINDOW_MS,
  MAX_OUTPUT_LEN,
  RAW_LOG_MAX,
  DONE_TAG,
} from "./constants.js"
import log from "./log.js"
import { SessionHistory } from "./history.js"
import { toModelText, extractOutputStart } from "./utils.js"
import { detectLastDoneMarker, stripMarkers, detectInterrupt, adapters, type ShellAdapter } from "./shell-adapter.js"
import { tr, type Lang } from "./i18n.js"

/** 命令执行结果 */
export interface ExecResult {
  ok: boolean
  output: string
  interactive?: boolean
  running?: boolean
  submitted?: boolean
  error?: string
  host?: string
  command?: string
  duration?: number
}

/** 生命周期事件（命令开始/完成），供 agent 转报 server（web 与插件自身 exec 统一来源） */
export type LifecycleEvent =
  | { type: "start"; command: string; ts: number }
  | { type: "done"; exitCode: number | null; endTs: number; output?: string }

/** 交互触发词（sudo 密码 / 分页器 / 确认提示），含中英文 */
const INTERACTIVE_RE =
  /(\[sudo\] password for|password for \S+:|\*\*\*\s*$|Password:|密码:|--More--|\(END\)|\[y\/N\]|\[Y\/n\]|yes\/no|是\/否)/i

/** buffer 最大长度（未消费输出超限时截断头部，防内存膨胀） */
const MAX_BUFFER_LEN = 2 * 1024 * 1024

/** 后台监听最长存活时间（防泄漏） */
const MAX_WATCH_LEN = 10 * 60_000

/** Shell 探测等待超时 */
const PROBE_TIMEOUT_MS = 5_000

/**
 * 剥离命令尾部注释：仅当 `#` 在行首或前有空白、且不在单双引号内（支持反斜杠转义）时视为注释，
 * 避免 `echo "a#b"` / `echo 'a#b'` 引号内的 # 被误剥，也避免 marker 被真注释吞掉。
 * @param s 命令文本
 * @returns 剥离尾注释（若有）后的文本
 */
function stripTrailingComment(s: string): string {
  let inSingle = false
  let inDouble = false
  let escaped = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (c === "\\") {
      escaped = true
      continue
    }
    if (c === "'" && !inDouble) {
      inSingle = !inSingle
      continue
    }
    if (c === '"' && !inSingle) {
      inDouble = !inDouble
      continue
    }
    if (c === "#" && !inSingle && !inDouble && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i).trimEnd()
    }
  }
  return s.trimEnd()
}

/**
 * 剥离命令尾部注释与尾部运算符，避免拼装 `;marker` 时：
 * - 尾注释 `# xxx` 把 marker 整行吞掉 → 检测不到完成
 * - 尾运算符 `&`、`;`、`&&`、`||` 与拼接的 `;` 形成 `&;`/`;;` 等语法错误
 * @param command 原始命令
 * @returns 可安全拼装 marker 的命令体
 */
function stripCommandTail(command: string): string {
  // 仅处理最后一行：多行命令（如 heredoc 正文）中间的 `#` 是内容，若在此截断会把命令切断
  const nl = command.lastIndexOf("\n")
  const head = nl >= 0 ? command.slice(0, nl + 1) : ""
  const last = nl >= 0 ? command.slice(nl + 1) : command
  let s = stripTrailingComment(last)
  s = s.replace(/(?:&&|\|\||[;&|])[\s]*$/, "")
  return (head + s).trimEnd()
}

/** 会话命令执行与读取的公共实现 */
export abstract class BaseSession {
  protected _connected = false
  protected _remoteBusy = false
  /**
   * 是否保持 busy：排队命令顺序执行时，中间某条完成也不清 busy，
   * 直到序列最后一条完成（否则 web/status 会在中间命令间隙闪 busy=false）。
   */
  private _holdBusy = false
  protected _buffer = ""
  protected _connectedAt = 0
  protected _lastActive = 0
  protected _runningStartPos: number | null = null
  protected _runningCommand = ""
  protected _watchTimer: ReturnType<typeof setInterval> | null = null
  /** 命令序号（完成标记 <SSH_DONE:seq:code> 标识本次命令，防残留误判） */
  private _cmdSeq = 0
  /** 当前命令序号（_beginCapture 递增，供检测/拼接用） */
  private _runningSeq = 0
  /** 下次捕获窗口起点（相对当前 buffer）：前一条命令结束后，标记/残留从此处开始 */
  protected _cursor = 0
  /** WS 实时流已发送位置（相对 buffer 偏移）；null = 尚未定位命令回显结束点 */
  protected _streamPos: number | null = null
  /** Shell 适配器（探测后确定） */
  protected _adapter: ShellAdapter | null = null
  /** 多行命令写入 PTY 的行分隔符：Unix PTY 用 \n；Windows ConPTY（本地会话）用 \r（裸 \n 不提交行） */
  protected _lineSep = "\n"
  protected _closed = false
  /** 当前运行命令的输入时刻（history 记录展示命令发起时间用） */
  private _runningStartTs = 0
  /** 连续原始字节流（从首字节起累积，含欢迎页/探测/注入/提示符/marker）；ring 裁剪 */
  private _rawLog = ""
  /** 已裁剪丢弃的字符数（前端 pos 同步用） */
  private _rawDiscarded = 0
  /** 累积原始字节总数（单调递增，前端增量游标） */
  private _rawTotal = 0
  protected readonly _history: SessionHistory
  /** 生命周期监听器（命令开始/完成事件，agent 转报 server） */
  private _lifecycle: ((ev: LifecycleEvent) => void) | null = null
  /**
   * 本次命令期间是否真实发送过中断（Ctrl-C）。
   * 中断判定不依赖"命令回显定位"：超宽命令被 readline 折行重绘时回显会多出字符，
   * 精确匹配必然失败（echoEnd=0），若再以 echoEnd 为前置条件则 ^C 永远检测不到 → busy 卡死。
   * 仅当确实发过 ^C 才去缓冲区找 ^C 回显，天然排除历史残留 ^C 的误判。
   */
  private _interruptSent = false

  constructor(
    protected readonly sessionID: string,
    history: SessionHistory,
    protected readonly name = "default",
    protected readonly _lang: Lang = "en",
  ) {
    this._history = history
  }

  /** 向传输层写入字节（子类实现：SSH 写 stream / 本地写 Bun.Terminal） */
  protected abstract _write(data: string): void
  /** 关闭传输层资源（子类实现：SSH 关 client+stream / 本地关 term+proc） */
  protected abstract _closeTransport(): void
  /** 结果中的类型专属字段（SSH 附加 host，本地为空） */
  protected get _extraResult(): Partial<ExecResult> { return {} }

  /**
   * 异步提交命令：立即返回，命令后台执行，输出由后台监听收集进 history
   * @param command 命令
   * @returns 提交结果（立即返回，不等待命令完成）
   */
  async submit(command: string): Promise<ExecResult> {
    if (!this._ready()) return { ok: false, output: "", error: tr("err_not_connected", this._lang) }
    if (this._remoteBusy) return { ok: false, output: "", error: tr("cmd_busy", this._lang) }
    if (this._adapter?.hasOpenContinuation(command)) return { ok: false, output: "", error: tr("cmd_continuation", this._lang) }

    this._beginCapture(command)
    this._write(this._composeCommand(command))
    this._startBackgroundWatch(0, command)

    return { ok: true, output: "", submitted: true, command, duration: 0, ...this._extraResult }
  }

  /**
   * 在当前终端执行命令（同步等待），保留 cwd/环境
   * @param command 命令
   * @returns 执行结果
   */
  async exec(command: string): Promise<ExecResult> {
    const startTs = Date.now()
    if (!this._ready()) return { ok: false, output: "", error: tr("err_not_connected", this._lang) }
    if (this._remoteBusy) { log.info(`exec quick-fail busy: ${command} (busy=${this._remoteBusy})`); return { ok: false, output: "", error: tr("cmd_busy", this._lang) } }
    if (this._adapter?.hasOpenContinuation(command)) { log.info(`exec quick-fail open continuation: ${command}`); return { ok: false, output: "", error: tr("cmd_continuation", this._lang) } }

    this._beginCapture(command)
    const captureStart = this._buffer.length
    this._write(this._composeCommand(command))

    const outcome = await this._waitCompletion(0, startTs)

    log.info(`exec ${command} -> ${outcome.kind}${outcome.kind==="running"?"":" markerPos="+outcome.markerPos} (busy=${this._remoteBusy})`)

    switch (outcome.kind) {
      case "done": {
        this._remoteBusy = this._holdBusy // 排队序列中间命令：保持 busy 到序列结束
        const raw = this._buffer.slice(captureStart, outcome.markerPos ?? this._buffer.length)
        this._cursor = Math.max(0, outcome.markerPos ?? this._buffer.length)
        const out = this._extractOutput(raw, command)
        this._history.append(command, out, this._runningStartTs, Date.now())
        this._emitDone(outcome.exitCode ?? null, Date.now(), out)
        this._clearRunningContext()
        return { ok: true, output: this._truncate(await toModelText(out)), command, duration: Date.now() - startTs, ...this._extraResult }
      }
      case "interactive": {
        // 交互程序（sudo 密码 / 确认提示）：命令仍在等待用户输入，
        // 保留 running 上下文与 busy 状态，转后台 watch 持续监听完成标记；
        // 用户 send 输入后命令完成时由 watch 完整收集输出并翻转 busy（防新命令被当 exec 塞进运行中 shell）
        const raw = this._buffer.slice(captureStart)
        const out = this._extractOutput(raw, command)
        this._startBackgroundWatch(captureStart, command)
        return { ok: true, output: this._truncate(await toModelText(out)), interactive: true, command, duration: Date.now() - startTs, ...this._extraResult }
      }
      case "running": {
        this._runningStartPos = 0
        this._remoteBusy = true
        this._cursor = this._buffer.length
        this._startBackgroundWatch(captureStart, command)
        // 等待后台 watch 完成（不设硬超时，模型可通过 Ctrl-C 中断）
        await new Promise<void>((resolve) => {
          const poll = setInterval(() => {
            if (!this._remoteBusy) {
              clearInterval(poll)
              resolve()
            }
          }, 200)
        })
        // watch 已写入 history，取最后一条记录的输出
        const pairs = this._history.getPairs()
        const last = pairs[pairs.length - 1]
        const output = last ? this._truncate(await toModelText(stripMarkers(this._history.readOutput(last)))) : ""
        return { ok: true, output, command, duration: Date.now() - startTs, ...this._extraResult }
      }
    }
  }

  /**
   * 读取并清空未消费缓冲（交互/轮询场景）
   * @returns 未消费输出
   */
  async readBuffer(): Promise<{ ok: boolean; output: string; error?: string }> {
    if (!this._connected) return { ok: false, output: "", error: tr("err_not_connected", this._lang) }
    let out: string
    if (this._runningStartPos !== null && this._runningCommand) {
      const marker = detectLastDoneMarker(this._buffer, this._runningStartPos, this._runningSeq)
      if (marker.done) {
        const raw = this._buffer.slice(this._runningStartPos, marker.pos)
        this._buffer = this._buffer.slice(marker.pos)
        this._cursor = 0
        this._clearRunningContext()
        out = raw
      } else {
        out = this._buffer.slice(this._runningStartPos)
      }
    } else {
      out = this._buffer
      this._buffer = ""
      this._cursor = 0
    }
    return { ok: true, output: this._truncate(await toModelText(out)) }
  }

  /**
   * 发送文本/按键到终端（交互场景：sudo 密码、确认、中断等）
   * 转义序列：\r 或 \n = 回车，\x03 = Ctrl-C，\x04 = Ctrl-D，\x1a = Ctrl-Z，\x1b = ESC
   * @param text 要发送的文本或按键序列
   * @returns 是否发送成功
   */
  send(text: string): { ok: boolean; error?: string } {
    if (!this._connected) return { ok: false, error: tr("err_not_connected", this._lang) }
    const payload = text
      .replace(/\\x1b/gi, "\x1b")
      .replace(/\\x03/gi, "\x03")
      .replace(/\\x04/gi, "\x04")
      .replace(/\\x1a/gi, "\x1a")
      .replace(/\\r/g, "\r")
      .replace(/\\n/g, "\r")
    log.info(`send -> ${JSON.stringify(payload)} (connected=${this._connected}, busy=${this._remoteBusy})`)
    // 真实中断输入：标记本次命令已发过 Ctrl-C，供完成判定识别 ^C 回显（不依赖命令回显定位）
    if (payload.includes("\x03")) this._interruptSent = true
    this._write(payload)
    this._lastActive = Date.now()
    return { ok: true }
  }

  getHistory(): SessionHistory { return this._history }

  getRunningOutput(): string {
    if (this._runningStartPos === null || !this._connected || !this._runningCommand) return ""
    return this._buffer.slice(this._runningStartPos)
  }

  getRunningCommand(): string {
    return this._runningStartPos !== null && this._connected ? this._runningCommand : ""
  }

  /**
   * 设置命令生命周期监听器（命令开始/完成时回调）
   * @param listener 回调（start 携带命令，done 携带退出码与结束时刻；null 表示清除）
   */
  setLifecycle(listener: ((ev: LifecycleEvent) => void) | null): void {
    this._lifecycle = listener
  }

  /**
   * 设置是否保持 busy（排队命令序列期间为 true）：
   * true 时中间命令完成不清 busy；置 false 时立即清 busy。
   * @param hold 是否保持
   */
  setHoldBusy(hold: boolean): void {
    this._holdBusy = hold
    if (!hold) this._remoteBusy = false
  }

  /** 触发命令开始事件 */
  private _emitStart(command: string, ts: number): void {
    try { this._lifecycle?.({ type: "start", command, ts }) } catch { /* 监听器异常不打断执行 */ }
  }

  /** 触发命令完成事件 */
  private _emitDone(exitCode: number | null, endTs: number, output?: string): void {
    try { this._lifecycle?.({ type: "done", exitCode, endTs, output }) } catch { /* 同上 */ }
  }

  hasRunningStream(): boolean {
    return this._runningStartPos !== null && this._connected && this._runningCommand !== ""
  }

  /**
   * 增量取运行中命令的实时输出（WS 推流用）：
   * 首次定位命令回显结束点，后续返回增量；done 标记出现 → 返回剩余 + done
   * @returns data 本次增量；done 命令已完成
   */
  getRunningStream(): { data: string; done: boolean } {
    if (this._runningStartPos === null || !this._connected || !this._runningCommand) {
      this._streamPos = null
      return { data: "", done: false }
    }
    // 完成标记先定位（marker 唯一 seq，从命令起点搜索，免疫 echoEnd 被后序回显带偏）
    const marker = detectLastDoneMarker(this._buffer, this._runningStartPos, this._runningSeq)
    const markerEnd = marker.done ? marker.pos : this._buffer.length
    const end = extractOutputStart(this._buffer.slice(this._runningStartPos), this._composeEchoText(this._runningCommand), markerEnd - this._runningStartPos)
    if (end <= 0) return { data: "", done: false }
    const echoEnd = this._runningStartPos + end
    const windowEnd = marker.done ? marker.pos : this._buffer.length
    if (this._streamPos === null) {
      this._streamPos = echoEnd
    }
    const raw = this._buffer.slice(this._streamPos, windowEnd)
    this._streamPos = windowEnd
    let data = stripMarkers(raw)
    if (this._adapter) data = data.replace(this._markerCmd(this._runningSeq), "")
    return { data, done: marker.done }
  }

  /** 关闭终端，清理会话态（幂等） */
  close(): void {
    if (this._closed) return
    this._closed = true
    if (this._watchTimer) clearInterval(this._watchTimer)
    this._closeTransport()
    this._connected = false
    this._remoteBusy = false
    this._history.dispose()
  }

  /** 增量读取连续原始字节流：返回自 pos 之后的新增字节 */
  readRawStream(pos: number): { data: string; pos: number; reset?: boolean } {
    if (pos < this._rawDiscarded) return { data: this._rawLog, pos: this._rawTotal, reset: true }
    const from = pos - this._rawDiscarded
    return { data: this._rawLog.slice(from), pos: this._rawTotal }
  }

  /** 是否连接且传输层就绪（子类检查自身传输对象） */
  protected abstract _ready(): boolean

  /**
   * 本会话当前命令的完成标记命令（adapter 负责各自的标记语法，无 adapter 时用 POSIX 默认）
   * @param seq 命令序号
   * @returns 标记命令文本
   */
  private _markerCmd(seq: number): string {
    return this._adapter ? this._adapter.markerCmd(seq) : `printf '\\n${DONE_TAG}${seq}:%s>' $?`
  }

  /**
   * 组合实际写入 PTY 的命令：在规范形式（`_composeEchoText`）基础上把换行改写为行分隔符并补尾部回车。
   * 行分隔符按**探测到的 shell 类型/平台**决定，而非按传输类型（本地/SSH）：
   * - Windows shell（pwsh/cmd，控制台为 ConPTY）→ `\r`；本地 ConPTY 会话（无 adapter 时由 `_lineSep` 覆盖为 `\r`）→ `\r`；
   * - SSH + POSIX（zsh/bash，走 Unix PTY）→ `\n`（`_lineSep` 默认值）。
   * 原因：ConPTY 下裸 `\n` 只下移不复位、不提交行 → 多行命令逆序执行并卡在 `>>` 续行，须用 `\r`；
   * 实测 SSH 连到 Windows 的 pwsh：用 `\n` 分隔时命令逆序卡死，改用 `\r` 后行序正确、组内作用域保留、输出正常。
   * Unix PTY 下 `\n` 可正常提交行，保持不变。
   * @param command 原始命令（history 存干净版本）
   * @returns 实际写入 PTY 的文本（尾部带 \r，行分隔已按 shell 类型/平台规范化）
   */
  private _composeCommand(command: string): string {
    // 行分隔符优先按 shell 类型判定：Windows shell（pwsh/cmd）→ \r；否则沿用会话 _lineSep
    const sep = this._adapter?.windowsShell ? "\r" : this._lineSep
    return this._composeEchoText(command).replace(/\n/g, sep) + "\r"
  }

  /**
   * 组合命令文本（规范/匹配用形式，始终以 `\n` 分隔行、无尾部回车）：命令 + 完成标记。
   * 该形式供 `extractOutputStart` 按 `\n` 切行并做段间宽松匹配（跳过 `>>` 续行提示），
   * 故不可改写为 `_lineSep`——否则本地会话（`\r`）下整段回显变一行、段间匹配失效、回显剥离失败。
   * 完成标记用当前 shell 的语句分隔符同行拼接（POSIX/pwsh 为 `;`，cmd 为 `&`），免疫 prompt 框架覆盖：
   * `python; printf ...` 中 printf 由 shell 在 python 退出后执行，不会被 REPL 当 stdin 消费
   * （实测 top/read/python 均正常出 marker）。
   * 多行命令用 shell 组语法（groupWrap）包裹成**一条**命令：一次输入 = 一条命令 = 一段输出，
   * 避免 shell 逐行执行导致回显与输出交错、中间输出被 extractOutputStart 丢掉
   * （如 `cd /tmp` 之后的 `echo AAA`/`echo BBB` 输出丢失）；heredoc 分隔符行必须独占一行，
   * 若标记直接拼上去（`EOF ;printf ...`）会让分隔符失效 → heredoc 永不结束 → 卡死，
   * 故含 heredoc 的多行命令也必须包组。
   * cmd 无法安全包组（组内 `%errorlevel%` 为解析期展开、退出码失真）或无 adapter 时回退原样拼接。
   * 交互程序（top/vi/read/python 等）期间保留 running 上下文与 busy，marker 出现即判定完成。
   * @param command 原始命令
   * @returns 命令 + 标记文本（规范 `\n` 形式，无尾部回车）
   */
  private _composeEchoText(command: string): string {
    const marker = this._markerCmd(this._runningSeq)
    const body = stripCommandTail(command)
    const sep = this._adapter?.stmtSep ?? ";"
    // 多行命令：尝试包组（cmd 返回 null → 回退原样拼接），使整段作为一条命令执行
    if (body.includes("\n")) {
      const grouped = this._adapter?.groupWrap(body)
      return grouped ? `${grouped} ${sep}${marker}` : `${body} ${sep}${marker}`
    }
    return `${body} ${sep}${marker}`
  }

  /**
   * 提取命令纯输出：从命令回显后切到完成标记（无标记则切到中断回显 ^C 处），
   * 顺带去掉追加的标记命令回显行。
   * 回显定位使用组合命令文本（command + 标记段）而非裸命令：裸命令可能出现在程序错误输出中
   * （如 `pw` 的错误行 `bash: pw: command not found`），而组合命令整行回显是唯一的，
   * 可避免 last-match 误命中错误行导致输出被裁空。
   * @param raw 本次执行窗口原始字节流
   * @param command 原始命令（历史用）
   * @returns 纯程序输出原始流
   */
  private _extractOutput(raw: string, command: string): string {
    // 完成标记先定位：marker 自带唯一 seq，从窗口起点搜索即可（echoEnd 可能被连续输入的后序回显带偏）
    const marker = detectLastDoneMarker(raw, 0, this._runningSeq)
    const echoText = this._composeEchoText(command)
    const end = marker.done ? extractOutputStart(raw, echoText, marker.pos) : extractOutputStart(raw, echoText)
    if (end <= 0) return stripMarkers(raw)
    let out: string
    if (marker.done) {
      out = raw.slice(end, marker.pos)
    } else {
      const intr = detectInterrupt(raw, end)
      out = intr.interrupted ? raw.slice(end, intr.pos) : raw.slice(end)
    }
    if (this._adapter) out = out.replace(this._markerCmd(this._runningSeq), "")
    return stripMarkers(out.replace(/^[\r\n]+/, ""))
  }

  /** 命令执行/提交前准备：裁剪已消费缓冲 + 丢弃上一条命令的迟到残留标记 */
  private _beginCapture(command: string): void {
    // 用上一条命令完成标记（<SSH_DONE:seq:N>，此刻 _runningSeq 仍是上一条的）定位命令起点；
    // 备屏重放等场景下 buffer 可能含旧标记，裁剪到最后一个标记之后即可
    const marker = detectLastDoneMarker(this._buffer, 0, this._runningSeq)
    if (marker.done) {
      this._buffer = this._buffer.slice(marker.pos)
      this._cursor = 0
    }
    // fallback：无标记时依赖 _cursor 裁剪
    this._buffer = this._buffer.slice(this._cursor)
    this._cursor = 0
    this._runningStartPos = 0
    this._runningCommand = command
    this._runningStartTs = Date.now()
    this._interruptSent = false // 新命令：清除上一条/空闲期发出的 Ctrl-C 标记
    this._cmdSeq += 1
    this._runningSeq = this._cmdSeq
    this._remoteBusy = true
    this._lastActive = Date.now()
    this._emitStart(command, this._runningStartTs)
  }

  /** 追加输出字节：维护业务缓冲 + 连续原始流 ring */
  protected _appendBuffer(text: string): void {
    this._buffer += text
    if (this._buffer.length > MAX_BUFFER_LEN) {
      const trimmed = this._buffer.length - MAX_BUFFER_LEN
      this._buffer = this._buffer.slice(trimmed)
      if (this._runningStartPos !== null) this._runningStartPos = Math.max(0, this._runningStartPos - trimmed)
      this._cursor = Math.max(0, this._cursor - trimmed)
      if (this._streamPos !== null) this._streamPos = Math.max(0, this._streamPos - trimmed)
    }
    this._rawLog += text
    this._rawTotal += text.length
    if (this._rawLog.length > RAW_LOG_MAX) {
      const trimmed = this._rawLog.length - RAW_LOG_MAX
      this._rawLog = this._rawLog.slice(trimmed)
      this._rawDiscarded += trimmed
    }
  }

  /** 探测 shell 类型：按各适配器 probeCommand 逐个探测（POSIX 系优先，pwsh/cmd 用各自独有命令），
   *  login shell 的 $0 带 - 前缀（-bash/-zsh）由对应 parseProbe 容忍 */
  protected async _probeShell(deadline: number): Promise<ShellAdapter | null> {
    while (Date.now() < deadline) {
      for (const candidate of adapters) {
        this._write(candidate.probeCommand + "\r")
        const output = await this._waitProbeOutput(Math.min(PROBE_TIMEOUT_MS, deadline - Date.now()))
        this._buffer = ""
        if (output !== null && candidate.parseProbe(output)) return candidate
      }
    }
    return null
  }

  /** 等待探测输出稳定：buffer 有内容且 500ms 不再变化则返回，超时返回 null */
  private async _waitProbeOutput(maxMs: number): Promise<string | null> {
    const start = Date.now()
    let lastLen = this._buffer.length
    let lastChange = Date.now()
    while (Date.now() - start < maxMs) {
      if (this._buffer.length > 0 && Date.now() - lastChange >= 500) return this._buffer
      if (this._buffer.length !== lastLen) {
        lastLen = this._buffer.length
        lastChange = Date.now()
      }
      await new Promise((r) => setTimeout(r, 50))
    }
    return this._buffer.length > 0 ? this._buffer : null
  }

  private _waitCompletion(
    startPos: number,
    startTs: number,
  ): Promise<{ kind: "done" | "interactive" | "running"; markerPos?: number; exitCode?: number }> {
    return new Promise((resolve) => {
      let lastLen = this._buffer.length
      const timer = setInterval(() => {
        if (INTERACTIVE_RE.test(this._buffer.slice(startPos))) {
          clearInterval(timer)
          resolve({ kind: "interactive" })
          return
        }
        const now = Date.now()
        const curLen = this._buffer.length
        if (curLen !== lastLen) lastLen = curLen
        // 完成判定（权威）：命令后追加的 printf 输出 <SSH_DONE>，或 Ctrl-C 中断时 TTY 回显 ^C。
        // marker 自带唯一 seq，从命令起点直接搜索即可（不依赖命令回显定位）
        const marker = detectLastDoneMarker(this._buffer, startPos, this._runningSeq)
        if (marker.done) {
          clearInterval(timer)
          resolve({ kind: "done", markerPos: marker.pos, exitCode: marker.exitCode })
          return
        }
        // ^C 中断：仅当本次命令确实发送过 Ctrl-C 才检测（无需命令回显定位，
        // 超宽命令折行重绘会让回显精确匹配失败；未发过 Ctrl-C 时缓冲区里的 ^C 只可能是残留）
        if (this._interruptSent) {
          const intr = detectInterrupt(this._buffer, startPos)
          if (intr.interrupted) {
            clearInterval(timer)
            resolve({ kind: "done", markerPos: intr.pos, exitCode: 130 })
            return
          }
        }
        // 超过动画窗口仍未出现完成信号 → 交给后台 watch 继续监听（不设硬超时）
        if (now - startTs >= ANIMATION_WINDOW_MS) {
          clearInterval(timer)
          resolve({ kind: "running" })
          return
        }
      }, 50)
    })
  }

  /** 后台监听：轮询 done 标记 / ^C 中断 → 收集输出进 history + busy=false */
  private _startBackgroundWatch(startPos: number, command: string): void {
    if (this._watchTimer) clearInterval(this._watchTimer)
    const born = Date.now()
    this._watchTimer = setInterval(() => {
      if (!this._connected || Date.now() - born > MAX_WATCH_LEN) {
        // 超时/断连：命令视为结束（可能从未完成），补发 done 防 server busy 卡死
        if (this._runningCommand) this._emitDone(null, Date.now())
        this._remoteBusy = false
        this._clearRunningContext()
        if (this._watchTimer) clearInterval(this._watchTimer)
        return
      }
      // marker 唯一 seq，从命令起点搜索（不依赖命令回显定位）
      const marker = detectLastDoneMarker(this._buffer, startPos, this._runningSeq)
      // ^C 中断：仅当本次命令确实发送过 Ctrl-C 才检测（超宽命令折行重绘会让回显精确匹配失败）
      const intr = this._interruptSent ? detectInterrupt(this._buffer, startPos) : { interrupted: false, pos: 0 }
      const end = marker.done ? marker.pos : intr.pos
      if (marker.done || intr.interrupted) {
        const raw = this._buffer.slice(startPos, end)
        const code = marker.done ? marker.exitCode : 130
        const out = this._extractOutput(raw, command)
        this._history.append(command, out, this._runningStartTs)
        this._emitDone(code, Date.now(), out)
        this._cursor = Math.max(startPos, end)
        this._remoteBusy = this._holdBusy // 排队序列中间命令：保持 busy 到序列结束
        this._clearRunningContext()
        if (this._watchTimer) clearInterval(this._watchTimer)
      }
    }, 200)
  }

  protected _clearRunningContext(): void {
    this._runningStartPos = null
    this._runningCommand = ""
    this._streamPos = null
    this._runningStartTs = 0
    this._interruptSent = false
  }

  private _truncate(s: string): string {
    if (s.length <= MAX_OUTPUT_LEN) return s
    return `${s.slice(0, MAX_OUTPUT_LEN)}\n... [output truncated, ${s.length} chars total]`
  }
}
