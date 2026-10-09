// BaseSession：SSH(SshSession) 与本地(LocalSession) 终端的公共基类
// 统一完成标记法：注入 PROMPT_COMMAND 脚本，命令完成时输出 <SSH_DONE:退出码>
// 子类仅需实现：连接建立(connect)、数据写入(_write)、传输层清理(_closeTransport)、状态字段(getStatus)

import { randomUUID } from "node:crypto"

import {
  ANIMATION_WINDOW_MS,
  MAX_OUTPUT_LEN,
  RAW_LOG_MAX,
  DONE_TAG,
  SYNTAX_QUIET_MS,
  SYNTAX_MAX_WAIT_MS,
  INTERRUPT_PROBE_INTERVAL_DEFAULT_SEC,
} from "./constants.js"
import log from "./log.js"
import { SessionHistory } from "./history.js"
import { toModelText, extractOutputStart, stripTrailingPromptLine } from "./utils.js"
import { detectLastDoneMarker, stripMarkers, detectInterrupt, detectSyntaxError, adapters, type ShellAdapter } from "./shell-adapter.js"
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
  /**
   * 命令发起前缓冲的末行（旧提示符行）：语法错误收尾时 shell 会重印同形提示符，
   * 据此把它从输出尾部剥掉（exec 的输出窗口自命令回显起，旧提示符在窗口之外，需单独记录）。
   */
  private _promptRef = ""
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
  /**
   * 会话实例代次：每次构造生成唯一值。同名终端重建/进程重启后新实例代次不同，
   * 供 agent 识别"已是新会话"并重置 raw 增量游标；随 raw 上报透传给 server，作为清屏（reset）依据。
   */
  readonly generation: string = randomUUID()
  /** 生命周期监听器（命令开始/完成事件，agent 转报 server） */
  private _lifecycle: ((ev: LifecycleEvent) => void) | null = null
  /**
   * 本次命令期间是否真实发送过中断（Ctrl-C）。
   * 中断判定不依赖"命令回显定位"：超宽命令被 readline 折行重绘时回显会多出字符，
   * 精确匹配必然失败（echoEnd=0），若再以 echoEnd 为前置条件则 ^C 永远检测不到 → busy 卡死。
   * 仅当确实发过 ^C 才去缓冲区找 ^C 回显，天然排除历史残留 ^C 的误判。
   */
  private _interruptSent = false
  /**
   * 已补发中断探针的命令序号集合（set 即"探针已发"记录）。
   * 探针在用户显式 Ctrl+C 时补发，其回显可能迟到落到后续命令的输出窗口里，
   * 保留序号以便无论何时到达都从可见输出中剔除其回显（见 _stripProbeEchoes）。
   * 不清空：迟到可能跨多条命令（Raw 视图保留原始字节，不经此剔除）。
   */
  private _probeSeqs = new Set<number>()
  /**
   * 中断探针周期定时器：Ctrl+C 后立即补发首条探针，随后每 _interruptProbeIntervalMs 补发一次。
   * null = 不在中断周期内。仅"周期性重发探针"用，不参与完成判定（完成只认当前 seq 标记）。
   */
  private _interruptTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    protected readonly sessionID: string,
    history: SessionHistory,
    protected readonly name = "default",
    protected readonly _lang: Lang = "en",
    /** 中断探针补发间隔（毫秒）；来自配置 interruptProbeInterval（秒），非法/缺失时为常量默认值 */
    protected readonly _interruptProbeIntervalMs: number = INTERRUPT_PROBE_INTERVAL_DEFAULT_SEC * 1000,
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
   * 提交命令：立即返回、不等待结果；命令在该终端前台执行，完成后由后台 watch 收集输出进 history
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
        const out = this._extractOutput(raw, command, outcome.syntaxError === true)
        this._history.append(command, out, this._runningStartTs, Date.now(), outcome.exitCode ?? undefined)
        this._emitDone(outcome.exitCode ?? null, Date.now(), out)
        this._stopInterruptCycle("命令完成")
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
        // 与后台 watch 完成路径复用同一收尾（history/done/busy/停 watch），避免 busy 卡死
        const raw = this._completeRunning(this._runningStartPos, marker.pos, marker.exitCode, this._runningCommand)
        // readBuffer 语义：读取后消费标记及之前部分（缓冲区坐标重置，cursor 归零）
        this._buffer = this._buffer.slice(marker.pos)
        this._cursor = 0
        out = raw
      } else {
        out = this._buffer.slice(this._runningStartPos)
      }
    } else {
      out = this._buffer
      this._buffer = ""
      this._cursor = 0
    }
    return { ok: true, output: this._truncate(await toModelText(this._stripProbeEchoes(out))) }
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
    // 真实中断输入：标记本次命令已发过 Ctrl-C；写完中断键后进入中断周期，
    // 周期内**立即**补发首条探针、之后按配置间隔（默认 5s）补发探针标记来收尾被中断的命令。
    // 防抖：周期内重复 Ctrl-C 被 _startInterruptCycle 抑制（不重启周期、不额外补探针），
    // 但 \x03 字节本身仍照常写入 PTY（不吞按键，保留"连按两次退出"等程序行为）。
    const interrupted = payload.includes("\x03")
    if (interrupted) this._interruptSent = true
    this._write(payload)
    if (interrupted) this._startInterruptCycle()
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
    data = this._stripProbeEchoes(data)
    return { data, done: marker.done }
  }

  /** 关闭终端，清理会话态（幂等） */
  close(): void {
    if (this._closed) return
    this._closed = true
    if (this._watchTimer) clearInterval(this._watchTimer)
    this._stopInterruptCycle("会话关闭")
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
    // 行分隔符按 shell 类型/平台判定（见 _ptyLineSep）
    return this._composeEchoText(command).replace(/\n/g, this._ptyLineSep()) + "\r"
  }

  /**
   * 当前 shell 的 PTY **提交分隔符**（让 shell 执行该行）：Windows shell（pwsh/cmd，ConPTY）→ `\r`
   * （裸 \n 不提交行）；其余沿用会话 `_lineSep`（Unix PTY 为 \n，本地会话为 \r）。
   * @returns 提交分隔符字符串
   */
  private _ptyLineSep(): string {
    return this._adapter?.windowsShell ? "\r" : this._lineSep
  }

  /**
   * 组合中断探针写入文本：**不加任何前缀换行**，直接写一条独立的当前 seq 完成标记命令，
   * 末尾用**提交分隔符**让 shell 执行该行。
   *
   * 不加前缀换行的原因：Ctrl+C 后插入的前导 `\r`/`\n` 会被 shell 各算一次 accept-line，
   * 在 SIGINT + 提示符重绘期间额外提交空命令，PTY 回声与 bash readline 增量重绘竞态，
   * 使 marker 回显在字节流里被截断成残片（如缺开头 12 字节的 `printf '\n<S...`），无法被精确剔除。
   * 探针在提示符处补发，本就是干净新行，无需前缀；提交仅靠尾部 `\r`，
   * 与 `_composeCommand` 尾部分隔符一致。
   * @param seq 探针使用的命令序号（被中断命令的当前 seq）
   * @returns 写入 PTY 的探针文本
   */
  private _composeProbe(seq: number): string {
    return this._markerCmd(seq) + "\r"
  }

  /**
   * 补发一次中断探针：用户显式 Ctrl+C 后，前台命令可能已死、shell 已回到提示符，
   * 但命令列表被中断丢弃 → 原命令的完成标记永不执行 → busy 卡死。
   * 补写一条"裸标记命令"作为探针：shell 若已回到提示符会读它并打印当前 seq 标记，
   * 使命令正常收尾；若前台程序未死，字节留在 tty 输入缓冲，待 shell 拿回控制权时再读
   * （两种情况均符合预期，保持 busy、绝不误判完成）。
   * 由中断周期调用：写完 \x03 时立即调用一次，之后定时器每间隔调用一次（见 _startInterruptCycle）。
   * 幂等：同一条被中断命令多次补发（立即 1 条 + 每间隔 1 条），先到的当前 seq 标记胜出。
   * @returns 无
   */
  private _sendInterruptProbe(): void {
    // 仅在确实有正在追踪的命令时补发：空闲期 Ctrl+C 无待收尾命令，补发只会污染缓冲
    if (this._runningStartPos === null || this._runningCommand === "") return
    const seq = this._runningSeq
    this._probeSeqs.add(seq)
    const probe = this._composeProbe(seq)
    log.info(`中断探针 -> seq=${seq} ${JSON.stringify(probe)} (busy=${this._remoteBusy})`)
    this._write(probe)
  }

  /**
   * 启动中断周期：用户显式 Ctrl+C 后进入。**写完 \x03 立即补发首条探针**（同一次 send 调用内，不再等待），
   * 之后每 _interruptProbeIntervalMs（来自配置，默认 5s）补发一次，直至命令结束/关会话/开始新命令
   * （见 _stopInterruptCycle）。防抖：已在周期内时直接返回——狂按 Ctrl+C 不重启周期、不额外补探针
   * （\x03 字节仍由 send 照常写入）。空闲期（无正在追踪的命令）Ctrl+C 不进入周期，避免无谓探针污染缓冲。
   * 定时器只负责周期性重发探针，不做任何"到点判完成"。
   * @returns 无
   */
  private _startInterruptCycle(): void {
    // 防抖：周期内重复 Ctrl+C 直接忽略（不重启计时、不额外补探针）
    if (this._interruptTimer !== null) return
    // 空闲期 Ctrl+C 无待收尾命令：不进入周期
    if (this._runningStartPos === null || this._runningCommand === "") return
    const seq = this._runningSeq
    const intervalSec = this._interruptProbeIntervalMs / 1000
    log.info(`中断周期开始 -> seq=${seq}，已立即补发首条探针，之后每 ${intervalSec}s 一条`)
    // 写完 \x03 后立即补发首条探针（t0），后续 setInterval 自此刻起按间隔补发（t0+N、t0+2N…）
    this._sendInterruptProbe()
    this._interruptTimer = setInterval(() => { this._onInterruptTick() }, this._interruptProbeIntervalMs)
  }

  /**
   * 中断周期的一次 tick：先判命令是否仍在追踪中，不在则停周期并清状态（不判完成）；
   * 仍在则补发一次探针。完成判定始终只认当前 seq 的完成标记，与定时器无关。
   * @returns 无
   */
  private _onInterruptTick(): void {
    if (this._runningStartPos === null || this._runningCommand === "" || !this._connected) {
      this._stopInterruptCycle("命令已结束或会话关闭")
      return
    }
    this._sendInterruptProbe()
  }

  /**
   * 停止中断周期并清周期状态：清定时器，日志记录结束原因（幂等，未在周期内时不做任何事）。
   * 在命令完成收尾、关会话、开始新命令、运行上下文清理等路径调用。
   * @param reason 周期结束原因（用于日志）
   * @returns 无
   */
  private _stopInterruptCycle(reason: string): void {
    if (this._interruptTimer === null) return
    clearInterval(this._interruptTimer)
    this._interruptTimer = null
    log.info(`中断周期结束 -> ${reason}`)
  }

  /**
   * 从可见输出中剔除中断探针留下的痕迹（探针命令的回显）。
   * 探针在用户中断时补发，其回显可能迟到落到后续命令的输出窗口里；按已记录探针 seq
   * 生成精确回显文本并删除全部出现，从而无论何时到达都剔除。完成标记本身由 stripMarkers
   * 按标记模式统一去除（不限 seq）。Raw 视图不经此函数，保留原始字节。
   * @param text 可见输出文本
   * @returns 剔除探针回显后的文本
   */
  private _stripProbeEchoes(text: string): string {
    if (this._probeSeqs.size === 0) return text
    let out = text
    for (const seq of this._probeSeqs) {
      const echo = this._markerCmd(seq)
      if (out.includes(echo)) out = out.split(echo).join("")
    }
    return out
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
   * 语法错误路径（syntaxMode）另作两处特殊处理：
   * - 回显定位取**首次**匹配：pwsh 错误块的 `   1 |  <命令>` 行会重印含标记的整行命令，
   *   末次匹配会落到该拷贝上，导致 `ParserError:`/`Line |` 等错误块前半被裁掉；
   * - 剥掉尾部 shell 重印的提示符行（与旧提示符行同形，属画面噪音）。
   * @param raw 本次执行窗口原始字节流
   * @param command 原始命令（历史用）
   * @param syntaxMode true 表示语法/解析错误收尾（无完成标记，整行命令作废）
   * @returns 纯程序输出原始流
   */
  private _extractOutput(raw: string, command: string, syntaxMode = false): string {
    // 完成标记先定位：marker 自带唯一 seq，从窗口起点搜索即可（echoEnd 可能被连续输入的后序回显带偏）
    const marker = detectLastDoneMarker(raw, 0, this._runningSeq)
    const echoText = this._composeEchoText(command)
    const end = marker.done
      ? extractOutputStart(raw, echoText, marker.pos)
      : extractOutputStart(raw, echoText, raw.length, syntaxMode)
    if (end <= 0) {
      // 未定位到命令回显（超宽命令折行重绘等）：退回整窗；中断命令再截到首个 ^C 回显，
      // 避免输出残留 ^C 与探针后 shell 重印的提示符（与旧版"中断收尾"输出语义一致）
      let fallback = raw
      if (this._interruptSent) {
        const intr = detectInterrupt(raw, 0)
        if (intr.interrupted) fallback = raw.slice(0, intr.pos)
      }
      return this._stripProbeEchoes(stripMarkers(fallback))
    }
    let out: string
    if (marker.done) {
      // 中断命令：完成标记由探针补发，输出窗口会多出 ^C 回显、重印提示符与探针回显；
      // 输出在首个 ^C 回显处截断，保留中断前程序输出（探针回显另由 _stripProbeEchoes 剔除）
      let endPos = marker.pos
      if (this._interruptSent) {
        const intr = detectInterrupt(raw, end)
        if (intr.interrupted) endPos = Math.min(endPos, intr.pos)
      }
      out = raw.slice(end, endPos)
    } else if (syntaxMode) {
      // 语法错误：命令整行作废、无 marker → 输出 = 回显结束 → 窗口末尾（含整段错误块），再剥尾部重印提示符
      out = stripTrailingPromptLine(raw.slice(end), raw, this._promptRef)
    } else {
      const intr = detectInterrupt(raw, end)
      out = intr.interrupted ? raw.slice(end, intr.pos) : raw.slice(end)
    }
    if (this._adapter) out = out.replace(this._markerCmd(this._runningSeq), "")
    return this._stripProbeEchoes(stripMarkers(out.replace(/^[\r\n]+/, "")))
  }

  /** 命令执行/提交前准备：裁剪已消费缓冲 + 丢弃上一条命令的迟到残留标记 */
  private _beginCapture(command: string): void {
    // 开始新命令：停掉上一条命令遗留的中断周期（新命令有自己的 seq 与收尾）
    this._stopInterruptCycle("开始新命令")
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
    // 记录命令发起前缓冲末行（旧提示符行）：语法错误收尾时 shell 会重印同形提示符，供输出尾部剥离
    this._promptRef = this._buffer.split("\n").pop() ?? ""
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

  /**
   * 同步等待命令完成：轮询语法错误 / 完成标记 / 交互提示 / ^C 中断，超动画窗口仍未完成则转后台 watch。
   * @param startPos 捕获窗口起点（相对当前 buffer）
   * @param startTs 命令发起时刻（判定动画窗口用）
   * @returns kind=done 时 exitCode 为退出码（语法错误无标记可读，为 null）；markerPos 缺省表示窗口取到缓冲区末尾；
   *          syntaxError=true 表示本次是语法/解析错误收尾（输出提取须改用首次回显匹配 + 剥尾部提示符）
   */
  private _waitCompletion(
    startPos: number,
    startTs: number,
  ): Promise<{ kind: "done" | "interactive" | "running"; markerPos?: number; exitCode?: number | null; syntaxError?: boolean }> {
    return new Promise((resolve) => {
      let lastLen = this._buffer.length
      // 语法错误收尾状态：syntaxSeenAt=0 表示尚未识别；quietAt=识别后输出最后一次变化的时刻
      let syntaxSeenAt = 0
      let syntaxQuietAt = 0
      let syntaxLen = 0
      const timer = setInterval(() => {
        const now = Date.now()
        const curLen = this._buffer.length
        if (curLen !== lastLen) lastLen = curLen
        // 语法/解析错误：**每轮最先判定**（优先于交互提示与"判为 running"），命中即进入静默等待再收尾。
        // 整行命令作废（含同行拼装的完成标记也不会执行）→ 视为命令已结束。
        // 不立即收尾：pwsh 的多行错误块由格式化器异步/批量渲染，须等输出安静一小段再收尾，
        // 否则只截到 `ParserError:` 首行、丢掉 Line | 等后续行；安静窗口 300ms，自识别起上限 1s。
        // 禁止"无标记超时即完成"式兜底：静默长命令（如 sleep）会被误判为已完成。
        if (detectSyntaxError(this._adapter, this._buffer, startPos)) {
          if (syntaxSeenAt === 0) {
            syntaxSeenAt = now
            syntaxQuietAt = now
            syntaxLen = curLen
          } else if (curLen !== syntaxLen) {
            syntaxLen = curLen
            syntaxQuietAt = now
          }
          if (now - syntaxQuietAt >= SYNTAX_QUIET_MS || now - syntaxSeenAt >= SYNTAX_MAX_WAIT_MS) {
            clearInterval(timer)
            // 无标记可读 → exitCode=null；markerPos 缺省 → 输出窗口取到缓冲区末尾（含整段错误）
            resolve({ kind: "done", exitCode: null, syntaxError: true })
            return
          }
        }
        if (INTERACTIVE_RE.test(this._buffer.slice(startPos))) {
          clearInterval(timer)
          resolve({ kind: "interactive" })
          return
        }
        // 完成判定（权威且唯一）：命令后追加的 printf 输出 <SSH_DONE:seq:code>。
        // marker 自带唯一 seq，从命令起点直接搜索即可（不依赖命令回显定位）。
        // ^C 回显不作为完成依据：捕获/忽略 SIGINT 的程序（mysql/REPL）同样回显 ^C 但命令未结束，
        // 据此判完成会把后续命令喂进运行中的程序；中断收尾改由 send() 补发的探针标记触发。
        const marker = detectLastDoneMarker(this._buffer, startPos, this._runningSeq)
        if (marker.done) {
          clearInterval(timer)
          resolve({ kind: "done", markerPos: marker.pos, exitCode: marker.exitCode })
          return
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

  /** 后台监听：轮询 done 标记 / 语法错误 / ^C 中断 → 收集输出进 history + busy=false */
  private _startBackgroundWatch(startPos: number, command: string): void {
    if (this._watchTimer) clearInterval(this._watchTimer)
    // 语法错误收尾状态：syntaxSeenAt=0 表示尚未识别；quietAt=识别后输出最后一次变化的时刻
    let syntaxSeenAt = 0
    let syntaxQuietAt = 0
    let syntaxLen = 0
    this._watchTimer = setInterval(() => {
      if (!this._connected) {
        // 断连：命令视为结束（可能从未完成），补发 done 防 server busy 卡死
        if (this._runningCommand) this._emitDone(null, Date.now())
        this._remoteBusy = false
        this._clearRunningContext()
        if (this._watchTimer) clearInterval(this._watchTimer)
        return
      }
      // 完成判定只认当前 seq 的标记：^C 回显不作为完成依据（捕获/忽略 SIGINT 的程序
      // 同样回显 ^C 但命令未结束，据此判完成会把后续命令喂进运行中的程序）。
      // 中断收尾由 send() 补发的探针标记触发（见 _sendInterruptProbe）。
      const marker = detectLastDoneMarker(this._buffer, startPos, this._runningSeq)
      if (marker.done) {
        this._completeRunning(startPos, marker.pos, marker.exitCode, command)
        return
      }
      // 语法/解析错误：整行命令作废（含同行拼装的完成标记也不会执行）→ 输出安静后按完成收尾，
      // 走与正常完成一致的路径（history / done 事件 / 清 running / 翻转 busy）；
      // exitCode=null（无标记可读），输出窗口 = 回显结束 → 缓冲区末尾（含整段多行错误块，
      // 回显取首次匹配并剥掉尾部重印的提示符行，见 _extractOutput 的 syntaxMode）
      if (detectSyntaxError(this._adapter, this._buffer, startPos)) {
        const now = Date.now()
        const len = this._buffer.length
        if (syntaxSeenAt === 0) {
          syntaxSeenAt = now
          syntaxQuietAt = now
          syntaxLen = len
        } else if (len !== syntaxLen) {
          syntaxLen = len
          syntaxQuietAt = now
        }
        if (now - syntaxQuietAt >= SYNTAX_QUIET_MS || now - syntaxSeenAt >= SYNTAX_MAX_WAIT_MS) {
          const out = this._extractOutput(this._buffer.slice(startPos), command, true)
          this._completeRunning(startPos, this._buffer.length, null, command, out)
          return
        }
      }
    }, 200)
  }

  /**
   * 统一命令完成收尾（供后台 watch 与 readBuffer 复用，避免两处收尾逻辑漂移）：
   * 提取/追加 history、补发 done 事件、定位 cursor、翻转 busy、清 running 上下文、停后台 watch。
   * @param startPos 命令捕获窗口起点（相对 buffer；watch 的捕获起点与 _runningStartPos 可能不同，须显式传入）
   * @param endPos 完成位置（marker/中断回显在 buffer 中的偏移）
   * @param exitCode 退出码（语法错误收尾为 null，^C 为 130）
   * @param command 原始命令（history 记录用）
   * @param out 已提取的纯输出；缺省时由 [startPos, endPos) 窗口经 _extractOutput 提取
   * @returns 本次完成窗口的原始片段（readBuffer 返回给调用方用）
   */
  private _completeRunning(startPos: number, endPos: number, exitCode: number | null, command: string, out?: string): string {
    const raw = this._buffer.slice(startPos, endPos)
    const output = out ?? this._extractOutput(raw, command)
    this._history.append(command, output, this._runningStartTs, undefined, exitCode ?? undefined)
    this._emitDone(exitCode, Date.now(), output)
    this._cursor = Math.max(startPos, endPos)
    this._remoteBusy = this._holdBusy // 排队序列中间命令：保持 busy 到序列结束
    this._stopInterruptCycle("命令完成")
    this._clearRunningContext()
    if (this._watchTimer) clearInterval(this._watchTimer)
    return raw
  }

  protected _clearRunningContext(): void {
    this._stopInterruptCycle("运行上下文清理")
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
