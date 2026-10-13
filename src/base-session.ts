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
  FALLBACK_WATCH_INTERVAL_MS,
  INTERRUPT_PROBE_INTERVAL_DEFAULT_SEC,
} from "./constants.js"
import log, { debug, describeSend, infoDedup, isDebugEnabled, tailLines, tailSummary } from "./log.js"
import { decodeTerminalEscapes } from "./escapes.js"
import { SessionHistory } from "./history.js"
import { toModelText, extractOutputStart, stripTrailingPromptLine, removeProbeEchoLines, ECHO_REGEX_MAX_CMD_CHARS, echoRegexSourceLength } from "./utils.js"
import { detectLastDoneMarker, stripMarkers, detectInterrupt, detectSyntaxError, adapters, type ShellAdapter } from "./shell-adapter.js"
import { tr, type Lang } from "./i18n.js"

/** 命令执行结果 */
export interface ExecResult {
  ok: boolean
  output: string
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

/** 命令完成判定结果（仅 exec 同步等待窗口使用；后台路径直接收尾、不返回） */
interface CompletionOutcome {
  kind: "done" | "running"
  /** done 时的完成标记结束偏移（缺省表示无标记，窗口取到缓冲区末尾，如语法错误收尾） */
  markerPos?: number
  /** done 时的退出码（语法错误无标记可读，为 null） */
  exitCode?: number | null
  /** done 是否由语法/解析错误收尾（输出提取须改用 syntaxMode） */
  syntaxError?: boolean
}

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

/**
 * 诊断辅助：转义控制字符，使日志单行可读（\r\n\t 转义、ESC 写成 \x1b）。
 * 仅供日志打印使用，不参与任何控制流。
 * @param s 原始字符串
 * @returns 控制字符已转义的字符串
 */
function escapeCtl(s: string): string {
  return s.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t").replace(/\x1b/g, "\\x1b")
}

/** 完成标记扫描命中项（宽松解析：求值式/回显式、新 nonce 式/旧式均识别） */
interface DoneMarkerHit {
  /** 标记起始偏移（`<` 处） */
  pos: number
  /** 标记结束偏移（`>` 之后一位，可作切片边界） */
  end: number
  /** 解析出的会话 nonce（旧格式/回显式无 nonce 时为空串） */
  nonce: string
  /** 解析出的命令序号（无法解析时为 null） */
  seq: number | null
}

/**
 * 扫描文本中所有完成标记（`<SSH_DONE:nonce:seq:code>` / `<SSH_DONE:seq:code>` / `<SSH_DONE:code>`）。
 * 宽松解析（不要求退出码为纯数字）：既覆盖求值式标记，也覆盖**命令行回显**里的标记片段
 * （重放内容中常见 `<SSH_DONE:2:$LASTEXITCODE>` 这种未求值的回显）。
 * 用途：① 诊断日志（窗口内混入的标记来自哪条命令）；② 定位失败时按标记边界裁剪窗口。
 * @param s 待扫描文本
 * @returns 命中列表（按出现顺序）
 */
function scanDoneMarkers(s: string): DoneMarkerHit[] {
  const out: DoneMarkerHit[] = []
  let from = 0
  for (;;) {
    const i = s.indexOf(DONE_TAG, from)
    if (i < 0) break
    const gt = s.indexOf(">", i + DONE_TAG.length)
    if (gt < 0) break // 未闭合：后续不再可能有完整标记
    const segs = s.slice(i + DONE_TAG.length, gt).split(":")
    let nonce = ""
    let seq: number | null = null
    if (segs.length >= 3) {
      nonce = segs[0]
      const n = Number.parseInt(segs[1], 10)
      seq = Number.isNaN(n) ? null : n
    } else if (segs.length === 2) {
      const n = Number.parseInt(segs[0], 10)
      seq = Number.isNaN(n) ? null : n
    }
    out.push({ pos: i, end: gt + 1, nonce, seq })
    from = gt + 1
  }
  return out
}

/** 会话命令执行与读取的公共实现 */
export abstract class BaseSession {
  protected _connected = false
  protected _remoteBusy = false
  protected _buffer = ""
  protected _connectedAt = 0
  protected _lastActive = 0
  protected _runningStartPos: number | null = null
  protected _runningCommand = ""
  protected _watchTimer: ReturnType<typeof setInterval> | null = null
  /** 后台兜底判定的捕获窗口起点（相对 buffer；submit 为 0，exec 转后台为 captureStart） */
  private _watchStartPos = 0
  /** 后台兜底判定写入 history 用的命令（独立保存，避免运行上下文清理后取不到） */
  private _watchCommand = ""
  /** 语法错误安静窗口的一次性定时器（数据到达时重置；到点即收尾，非轮询） */
  private _syntaxTimer: ReturnType<typeof setTimeout> | null = null
  /** 语法错误首次识别时刻（0=尚未识别） */
  private _syntaxSeenAt = 0
  /** 语法错误静默判定起点（识别后输出最后一次变化的时刻） */
  private _syntaxQuietAt = 0
  /** 语法错误识别后观测到的输出长度（判断输出是否仍在变化） */
  private _syntaxLen = 0
  /** exec 同步等待完成的一次性 animation 定时器（到点未完成 → 兑现 "running" 转后台） */
  private _animationTimer: ReturnType<typeof setTimeout> | null = null
  /** exec 同步等待完成的 resolver（数据到达/语法静默命中时由 _settleCompletion 兑现） */
  private _completionWaiter: { resolve: (o: CompletionOutcome) => void } | null = null
  /** exec 转后台后等待 busy 释放的 resolver 列表（busy 翻转为 false 时统一兑现，替代 200ms 轮询） */
  private _busyWaiters: Array<() => void> = []
  /** 命令序号（完成标记 <SSH_DONE:nonce:seq:code> 标识本次命令，防残留误判） */
  private _cmdSeq = 0
  /** 当前命令序号（_beginCapture 递增，供检测/拼接用） */
  private _runningSeq = 0
  /**
   * 会话级随机短串（8 位十六进制，构造时生成）：写进完成标记 `<SSH_DONE:<nonce>:<seq>:<code>>`。
   * 远端 Windows 控制台在新连接时会重放上一会话屏幕缓冲，其中含**别的会话**的完成标记；
   * 新会话 seq 必然从 1 起、与重放会话撞号 → 无 nonce 时会把重放标记当自己的完成/边界。
   * 只认自己 nonce：重放标记不再冒充本会话标记。
   */
  private readonly _nonce: string = randomUUID().replace(/-/g, "").slice(0, 8)
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
  /** 数据到达监听器（终端有新输出写入缓冲时回调，供 agent 事件驱动推流；null 清除） */
  private _dataListener: (() => void) | null = null
  /**
   * busy 状态翻转监听器（插件挂接）：命令运行期间收到 true、结束写回 false，
   * 供插件把实时 busy 同步到跨进程状态文件，避免命令执行前落盘的旧值一直"过期"。
   */
  private _busyListener: ((busy: boolean, reason: string) => void) | null = null
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
    this._armTracking(0, command)
    this._write(this._composeCommand(command))
    this._startFallbackWatch()

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
    if (this._remoteBusy) { log.info(`exec quick-fail busy ${this._logTag} cmdLen=${command.length} (busy=${this._remoteBusy})`); debug(`exec quick-fail busy ${this._logTag} cmd=${tailLines(command, 3)}`); return { ok: false, output: "", error: tr("cmd_busy", this._lang) } }
    if (this._adapter?.hasOpenContinuation(command)) { log.info(`exec quick-fail open continuation ${this._logTag} cmdLen=${command.length}`); debug(`exec quick-fail open continuation ${this._logTag} cmd=${tailLines(command, 3)}`); return { ok: false, output: "", error: tr("cmd_continuation", this._lang) } }

    this._beginCapture(command)
    const captureStart = this._buffer.length
    this._armTracking(captureStart, command)
    // 先挂同步等待者再写入：写命令可能同步回灌数据（本地 PTY 快速回显），事件驱动的 _settleCompletion
    // 需要等待者已就位；否则完成会被判成后台收尾、exec 空等
    const completion = this._awaitCompletion()
    this._write(this._composeCommand(command))

    const outcome = await completion

    debug(`exec ${this._logTag} seq=${this._runningSeq} cmdLen=${command.length} -> ${outcome.kind}${outcome.kind==="running"?"":" markerPos="+outcome.markerPos+" exitCode="+outcome.exitCode+" duration="+(Date.now()-startTs)+"ms"} (busy=${this._remoteBusy})`)
    debug(`exec ${this._logTag} seq=${this._runningSeq} cmd=${tailLines(command, 3)}`)

    switch (outcome.kind) {
      case "done": {
        // 同步完成：复用 _completeRunning 统一收尾（history/done/busy/[run] 结束日志/清上下文/停 watch），
        // 避免此处二次实现导致结束日志缺失与收尾逻辑漂移；syntaxError 收尾按 syntaxMode 先提取输出再传入
        const endPos = outcome.markerPos ?? this._buffer.length
        const out = this._extractOutput(this._buffer.slice(captureStart, endPos), command, outcome.syntaxError === true)
        this._completeRunning(captureStart, endPos, outcome.exitCode ?? null, command, out, outcome.syntaxError ? "direct(syntax)" : "direct")
        return { ok: true, output: this._truncate(await toModelText(out)), command, duration: Date.now() - startTs, ...this._extraResult }
      }
      case "running": {
        this._runningStartPos = 0
        this._setBusy(true, "cmdRunning")
        this._cursor = this._buffer.length
        // 转后台稀疏兜底监听（≥1s，仅覆盖断连等非数据事件）；完成判定仍由数据到达事件驱动
        this._startFallbackWatch()
        // 等待命令收尾：事件驱动（busy 翻转为 false 时兑现），不再 200ms 轮询
        await new Promise<void>((resolve) => { this._busyWaiters.push(resolve) })
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
      const marker = detectLastDoneMarker(this._buffer, this._runningStartPos, this._nonce, this._runningSeq)
      if (marker.done) {
        // 与后台 watch 完成路径复用同一收尾（history/done/busy/停 watch），避免 busy 卡死
        const raw = this._completeRunning(this._runningStartPos, marker.pos, marker.exitCode, this._runningCommand, undefined, "readBuffer")
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
   * 转义写法统一由 decodeTerminalEscapes 解码（见 src/escapes.ts）：
   * \xHH 任意字节、\t TAB、\r/\n 回车、\\ 字面反斜杠；非法/不完整写法原样保留。
   * 前端直接发送的真实控制字节（0x7f/0x09/ESC 序列等）不含反斜杠，逐字节原样通过，同一实现两条路径共用。
   * @param text 要发送的文本或按键序列（转义文本或真实字节）
   * @returns 是否发送成功
   */
  send(text: string): { ok: boolean; error?: string } {
    if (!this._connected) return { ok: false, error: tr("err_not_connected", this._lang) }
    const payload = decodeTerminalEscapes(text)
    // 只记长度与类型，绝不打印载荷内容（用户会把密码/密钥粘进命令框或按键）
    log.info(`send ${this._logTag} -> ${describeSend(payload)} (connected=${this._connected}, busy=${this._remoteBusy})`)
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

  /**
   * 本会话完成标记的随机串（只读）：供诊断/测试按真实格式构造标记。
   * @returns 8 位十六进制会话串
   */
  get nonce(): string { return this._nonce }

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
   * 设置数据到达监听器（每次终端有新输出写入缓冲时回调）：
   * SSH 的 `stream.on("data")` 与本地 PTY 的 data 回调最终都汇入 `_appendBuffer`，
   * 在此统一触发，供 agent 做事件驱动的节流推流（不再依赖固定周期轮询）。
   * @param listener 回调（null 表示清除）
   */
  setDataListener(listener: (() => void) | null): void {
    this._dataListener = listener
  }

  /**
   * 设置 busy 状态翻转监听器（命令开始/结束/断连等每次 busy 翻转时回调）：
   * 供插件把最新 busy 同步到跨进程状态文件（server 拿不到 agent 状态回退读状态文件时，
   * 读到的是命令运行期间的实时值，而非命令执行前落盘的过期值）。
   * @param listener 回调（busy 目标值 + 翻转原因；null 表示清除）
   */
  setBusyListener(listener: ((busy: boolean, reason: string) => void) | null): void {
    this._busyListener = listener
  }

  /**
   * 更新终端 busy 状态：仅在值翻转时记一行（会话/终端/当前 seq/翻转原因），
   * 供事后对齐状态时间线（busy 每次翻转都能对应到具体原因，不再出现"忙了却查不出为何"）。
   * @param next 目标 busy 值
   * @param reason 翻转原因（cmdStart / cmdRunning / cmdDone / 会话关闭 / 断连补 done 等）
   * @param quiet true 时该行降为 debug：用于"释放"与紧随其后的收尾行（如 [run] 结束）重复的场景，
   *   避免同一事件打两条 info（busy 时间线仍可由该收尾行还原）
   */
  protected _setBusy(next: boolean, reason: string, quiet = false): void {
    if (this._remoteBusy === next) return
    this._remoteBusy = next
    const line = `[busy] ${this._logTag} seq=${this._runningSeq} busy=${next} reason=${reason}`
    if (quiet) debug(line)
    else log.info(line)
    // 通知插件同步状态文件（busy 已更新，getStatus 读到新值）；监听器异常不打断执行
    try { this._busyListener?.(next, reason) } catch { /* 监听器异常不打断执行 */ }
    // busy 释放：事件驱动地兑现 exec 转后台后的等待者（替代旧的 200ms busy=false 轮询）
    if (!next && this._busyWaiters.length > 0) {
      const waiters = this._busyWaiters
      this._busyWaiters = []
      for (const w of waiters) {
        try { w() } catch { /* 等待者异常不打断状态翻转 */ }
      }
    }
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
    const marker = detectLastDoneMarker(this._buffer, this._runningStartPos, this._nonce, this._runningSeq)
    const markerEnd = marker.done ? marker.pos : this._buffer.length
    // 回显定位异常不得中断推流：按"未定位"处理（延续原有 end<=0 语义）
    let end: number
    try {
      end = extractOutputStart(this._buffer.slice(this._runningStartPos), this._composeEchoText(this._runningCommand), markerEnd - this._runningStartPos)
    } catch {
      end = -1
    }
    if (end <= 0) return { data: "", done: false }
    const echoEnd = this._runningStartPos + end
    const windowEnd = marker.done ? marker.pos : this._buffer.length
    if (this._streamPos === null) {
      this._streamPos = echoEnd
    }
    const raw = this._buffer.slice(this._streamPos, windowEnd)
    this._streamPos = windowEnd
    const data = this._stripProbeEchoes(stripMarkers(raw))
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
    this._setBusy(false, "会话关闭")
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
    return this._adapter ? this._adapter.markerCmd(this._nonce, seq) : `printf '\\n${DONE_TAG}${this._nonce}:${seq}:%s>' $?`
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
    debug(`中断探针 ${this._logTag} seq=${seq} ${JSON.stringify(probe)} (busy=${this._remoteBusy})`)
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
    log.info(`中断周期开始 ${this._logTag} seq=${seq}，已立即补发首条探针，之后每 ${intervalSec}s 一条`)
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
    log.info(`中断周期结束 ${this._logTag} seq=${this._runningSeq}，原因=${reason}`)
  }

  /**
   * 从可见输出中剔除中断探针留下的痕迹（探针命令的回显）。
   * 探针在用户中断时补发，其回显可能迟到落到后续命令的输出窗口里；这里对每个已记录探针 seq
   * （以及当前命令自身的标记命令回显）做 **ANSI 容忍定位**：即便 pwsh 语法高亮在 token 间插入
   * SGR、行首带提示符与 `\x1b[?25l`，也能命中并整段剔除（见 removeProbeEchoLines）。
   * 三处调用点（本函数、_extractOutput 的 out.replace、getRunningStream 的 data.replace）
   * 统一收敛至此，消除口径漂移。Raw 视图不经此函数，保留原始字节。
   * @param text 可见输出文本
   * @returns 剔除探针回显后的文本
   */
  private _stripProbeEchoes(text: string): string {
    const needles: string[] = []
    for (const seq of this._probeSeqs) needles.push(this._markerCmd(seq))
    // 当前命令的标记命令回显：原 out.replace(_markerCmd(_runningSeq)) / data.replace(...) 两种口径并入此处
    needles.push(this._markerCmd(this._runningSeq))
    return removeProbeEchoLines(text, needles, this._promptRef)
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
    const marker = detectLastDoneMarker(raw, 0, this._nonce, this._runningSeq)
    const echoText = this._composeEchoText(command)
    const echoLen = echoText.trim().length
    // 超长回显：extractOutputStart 会降级为"首/尾锚点"匹配（否则模式源约 265×长度，JSC 下会抛 too large）
    if (echoLen > ECHO_REGEX_MAX_CMD_CHARS) {
      debug(`[extract] ${this._logTag} seq=${this._runningSeq} 回显定位降级为首/尾锚点: echoLen=${echoLen} regexSrcLen=${echoRegexSourceLength(echoText)} (>阈值 ${ECHO_REGEX_MAX_CMD_CHARS})`)
    }
    let end: number
    try {
      end = marker.done
        ? extractOutputStart(raw, echoText, marker.pos)
        : extractOutputStart(raw, echoText, raw.length, syntaxMode)
    } catch (e) {
      // 回显定位异常绝不上抛（否则会中断完成收尾）：记一行后退回整窗输出
      log.info(`[extract] ${this._logTag} seq=${this._runningSeq} 回显定位失败, 退回整窗: echoLen=${echoLen} err=${e instanceof Error ? e.message : String(e)}`)
      end = -1
    }
    // 诊断：输出窗口坐标 + 是否退回整窗（startPos=回显结束偏移，endPos=窗口末尾；窗口长=endPos-startPos）
    const winStart = end <= 0 ? 0 : end
    const winEnd = marker.done ? marker.pos : raw.length
    debug(`[extract] ${this._logTag} seq=${this._runningSeq} 窗口: startPos=${winStart} endPos=${winEnd} 窗口长=${winEnd - winStart} markerSeq=${this._runningSeq} 是否退回整窗=${end <= 0 ? `是(定位失败, syntaxMode=${syntaxMode})` : "否"}`)
    // 诊断：窗口前 120 字符（仅 SSH_TOOL_DEBUG=1 时落盘）
    debug(`[extract] ${this._logTag} seq=${this._runningSeq} 窗口前120: ${escapeCtl(raw.slice(0, 120))}`)
    if (end <= 0) {
      // 未定位到命令回显（脏窗口含控制台屏幕重放/超宽命令折行重绘等）：
      // **不得退回整窗**——整窗会把重放的别会话命令行/标记当输出落盘（旧 bug：outLen=14019 全是杂物）。
      // 改为按窗口内已有标记边界裁剪：取"本命令自己的标记之前、所有非本 seq 标记之后"的边界，
      // 先把重放段整段切掉，再剥行首残余控制码噪音；定位仍失败也只剩边界之后的少量内容。
      const ownEnd = marker.done ? marker.pos : raw.length
      const boundary = this._fallbackBoundary(raw, ownEnd)
      let fallback = boundary > 0 ? raw.slice(boundary) : raw
      // 边界裁剪后"再试一次定位"：此时窗口已剔除重放段，回显残片可能恢复成可匹配的连续文本
      const retry = extractOutputStart(fallback, echoText, fallback.length, false)
      if (retry > 0) fallback = fallback.slice(retry)
      else fallback = this._stripLeadingControlNoise(fallback)
      log.info(`[extract] ${this._logTag} seq=${this._runningSeq} 定位失败改用标记边界: boundary=${boundary} retry=${retry} 裁剪后长=${fallback.length} 原窗长=${raw.length}`)
      // 中断命令再截到首个 ^C 回显，避免输出残留 ^C 与探针后 shell 重印的提示符（与旧版中断收尾语义一致）
      if (this._interruptSent) {
        const intr = detectInterrupt(fallback, 0)
        if (intr.interrupted) fallback = fallback.slice(0, intr.pos)
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
    return this._stripProbeEchoes(stripMarkers(out.replace(/^[\r\n]+/, "")))
  }

  /**
   * 回显定位失败时的标记边界裁剪：扫描窗口内所有完成标记，返回"本命令自己的标记之前、
   * 所有非本 seq 标记之后"的边界偏移（无合适标记时为 0）。
   * 用于把控制台屏幕重放（含上一会话的命令行与标记）整段切掉，避免其被当输出落盘。
   * 判定：只按 seq 区分——seq 等于当前命令序号的标记（求值式或命令行回显式）属于本次命令，
   * 不作边界（否则会把本次命令的回显一起切掉）；其余标记（重放的别会话标记）取最后一个的结束位置。
   * @param raw 待裁剪窗口原始字节流
   * @param ownEnd 本命令完成标记的结束偏移（无标记时为窗口末尾）
   * @returns 裁剪起点偏移（相对 raw）
   */
  private _fallbackBoundary(raw: string, ownEnd: number): number {
    let start = 0
    for (const h of scanDoneMarkers(raw)) {
      if (h.pos >= ownEnd) break
      if (h.seq === this._runningSeq) continue
      start = Math.max(start, h.end)
    }
    return start
  }

  /**
   * 剥掉文本开头的控制码/重绘噪音（光标定位、颜色、OSC 标题等非打印序列）与空白，
   * 直到首个可见字符；用于标记边界裁剪后仍残留的重绘噪音清理。
   * @param s 待清理文本
   * @returns 去掉行首控制噪音后的文本
   */
  private _stripLeadingControlNoise(s: string): string {
    return s.replace(/^(?:[\s\x00-\x1f\x7f]|\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[^\x1b])+/, "")
  }

  /** 命令执行/提交前准备：裁剪已消费缓冲 + 丢弃上一条命令的迟到残留标记 */
  private _beginCapture(command: string): void {
    // 诊断用：记录进入时的缓冲/游标快照（仅用于日志，不参与裁剪决策）
    const entryBufLen = this._buffer.length
    const entryCursor = this._cursor
    // 开始新命令：停掉上一条命令遗留的中断周期（新命令有自己的 seq 与收尾）
    this._stopInterruptCycle("开始新命令")
    // 用上一条命令完成标记（<SSH_DONE:nonce:seq:N>，此刻 _runningSeq 仍是上一条的）定位命令起点；
    // 只认自己 nonce：别的会话经控制台重放混入的旧标记不会被误当本会话边界
    const marker = detectLastDoneMarker(this._buffer, 0, this._nonce, this._runningSeq)
    if (marker.done) {
      this._buffer = this._buffer.slice(marker.pos)
    } else {
      // 无本会话标记（首命令且基线标记尚未到达/不可用）：至少按"非本 seq 标记"边界剥掉屏幕重放段
      const replayBoundary = this._fallbackBoundary(this._buffer, this._buffer.length)
      if (replayBoundary > 0) this._buffer = this._buffer.slice(replayBoundary)
    }
    // fallback：再依赖 _cursor 裁剪
    this._buffer = this._buffer.slice(this._cursor)
    this._cursor = 0
    // 诊断：本次窗口起点取自"自身找到的 lastMarkerPos"（无标记时为 0，即缓冲起点）；
    // captureStart=裁剪后残留长度（exec 的实际捕获起点，与缓冲内容相关，仅供参考）
    const winStartPos = marker.done ? marker.pos : 0
    debug(`[capture] ${this._logTag} seq=${this._cmdSeq + 1} 起点=${winStartPos} captureStart=${this._buffer.length}(参考) entryCursor=${entryCursor} bufLen=${entryBufLen} lastMarkerPos=${marker.done ? marker.pos : -1}`)
    // 记录命令发起前缓冲末行（旧提示符行）：语法错误收尾时 shell 会重印同形提示符，供输出尾部剥离
    this._promptRef = this._buffer.split("\n").pop() ?? ""
    this._runningStartPos = 0
    this._runningCommand = command
    this._runningStartTs = Date.now()
    this._interruptSent = false // 新命令：清除上一条/空闲期发出的 Ctrl-C 标记
    this._cmdSeq += 1
    this._runningSeq = this._cmdSeq
    this._setBusy(true, "cmdStart")
    this._lastActive = Date.now()
    debug(`[run] 开始 ${this._logTag} seq=${this._runningSeq} startPos=0 cmdLen=${command.length}`)
    debug(`[run] 开始 ${this._logTag} seq=${this._runningSeq} cmd=${JSON.stringify(command.slice(0, 120))}`)
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
    // 诊断：仅当本 chunk 含完成标记时记一行（回答"后续命令的标记为何在当前命令结束前就到"）
    if (text.includes(DONE_TAG)) {
      const found = scanDoneMarkers(text).map((h) => h.seq ?? "?").join(",")
      // 非内容信息保持 info（排障主力）；命令/输出片段前缀（prefix）降级为 debug，避免泄漏内容
      debug(`[chunk] ${this._logTag} seq=${this._runningSeq} runningStart=${this._runningStartPos} chunkLen=${text.length} found=[${found}]`)
      debug(`[chunk] ${this._logTag} seq=${this._runningSeq} prefix=${escapeCtl(text.slice(0, 60))}`)
    }
    // 数据已落缓冲：通知数据到达监听器（agent 据此做节流合并推流；异常不打断数据写入）
    try { this._dataListener?.() } catch { /* 监听器异常不打断数据写入 */ }
    // 完成判定改为事件驱动：每个数据块落入缓冲后立即判定完成标记/语法错误（异常不打断数据写入）
    this._onDataArrived()
  }

  /**
   * 会话初始化完成后发送**基线标记**（seq=0）：作为第一条命令的"前驱"。
   *
   * 背景：新连接时远端 Windows 控制台会重放上一会话的屏幕缓冲，其内容落在缓冲区开头。
   * 旧实现首条命令 `_beginCapture` 没有"上一条标记"可依，窗口被迫从缓冲起点（=重放内容）开始，
   * 回显定位失败便退回整窗 → 重放杂物被当输出落盘。
   * 发一条 seq=0 的求值标记后，首条命令能像后续命令一样"裁剪到上一条标记之后"，起点即干净。
   * 须在 shell 探测完成（adapter 已定）之后调用，使标记命令语法正确；写入方式与中断探针一致（尾随提交分隔符）。
   * @returns 无
   */
  protected _sendBaselineMarker(): void {
    const baseline = this._markerCmd(0) + "\r"
    debug(`[baseline] ${this._logTag} 初始化完成，发送基线标记 nonce=${this._nonce} seq=0`)
    this._write(baseline)
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
   * 挂起 exec 的同步完成等待（事件驱动，无轮询）：
   * - 数据到达（`_appendBuffer` → `_checkCompletion`）命中完成标记/语法静默时由 `_settleCompletion` 兑现；
   * - 超过 ANIMATION_WINDOW_MS 仍未完成则由一次性 animation 定时器兑现 "running"（转后台继续追踪，不设硬超时）。
   * @returns 完成结果（done 携带标记位置/退出码/语法错误标志；running 表示转后台）
   */
  private _awaitCompletion(): Promise<CompletionOutcome> {
    return new Promise<CompletionOutcome>((resolve) => {
      this._completionWaiter = { resolve }
      this._animationTimer = setTimeout(() => {
        this._animationTimer = null
        const w = this._completionWaiter
        if (w) {
          this._completionWaiter = null
          w.resolve({ kind: "running" })
        }
      }, ANIMATION_WINDOW_MS)
    })
  }

  /**
   * 数据到达事件钩子（由 `_appendBuffer` 在每个数据块落入缓冲后调用）：
   * 仅在追踪运行命令时触发完成判定，异常不打断数据写入。
   * @returns 无
   */
  private _onDataArrived(): void {
    if (this._runningStartPos === null || this._runningCommand === "") return
    try {
      this._checkCompletion(true)
    } catch (e) {
      log.info(`[watch] ${this._logTag} seq=${this._runningSeq} 数据到达判定异常, 保持监听: err=${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /**
   * 完成判定（唯一入口，事件驱动）：
   * 断连优先处理；其次判当前 seq 完成标记（权威且唯一）；再次判语法/解析错误（安静窗口后收尾）。
   * ^C 回显不作为完成依据：捕获/忽略 SIGINT 的程序（mysql/REPL）同样回显 ^C 但命令未结束，
   * 据此判完成会把后续命令喂进运行中的程序；中断收尾由 send() 补发的探针标记触发。
   * @param fromData true=数据到达触发（推进语法静默计时）；false=后台兜底 tick（不重置已挂的静默计时，避免无限顺延）
   * @returns 无
   */
  private _checkCompletion(fromData: boolean): void {
    if (this._runningStartPos === null || !this._runningCommand) return
    if (!this._connected) {
      this._handleDisconnect()
      return
    }
    try {
      // 完成判定（权威且唯一）：命令后追加的 printf 输出 <SSH_DONE:seq:code>；marker 自带唯一 seq，从命令起点搜索
      const marker = detectLastDoneMarker(this._buffer, this._runningStartPos, this._nonce, this._runningSeq)
      if (marker.done) {
        this._settleCompletion({ kind: "done", markerPos: marker.pos, exitCode: marker.exitCode })
        return
      }
      // 语法/解析错误：整行命令作废（含同行拼装的完成标记也不会执行）→ 输出安静后按完成收尾
      if (detectSyntaxError(this._adapter, this._buffer, this._watchStartPos)) {
        // 兜底 tick 不重置已挂的静默计时（否则每周期顺延、永不收尾）；数据到达时才推进
        if (fromData || this._syntaxTimer === null) this._armSyntaxQuiet()
      }
    } catch (e) {
      log.info(`[watch] ${this._logTag} seq=${this._runningSeq} 判定异常, 保持监听: err=${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /**
   * 兑现一次完成判定：有 exec 同步等待者时只回传结果（由 exec 走统一收尾）；
   * 无等待者（submit / exec 转后台）时直接调用 `_completeRunning` 收尾。
   * @param o 完成结果
   * @returns 无
   */
  private _settleCompletion(o: CompletionOutcome): void {
    const w = this._completionWaiter
    if (w) {
      this._completionWaiter = null
      this._clearAnimationTimer()
      w.resolve(o)
      return
    }
    if (o.kind !== "done") return
    if (o.syntaxError) {
      // 语法错误：输出窗口 = 回显结束 → 缓冲区末尾（含整段多行错误块），syntaxMode 提取
      let out: string
      try {
        out = this._extractOutput(this._buffer.slice(this._watchStartPos), this._watchCommand, true)
      } catch (e) {
        // 输出提取异常绝不影响收尾：退化为整窗原始输出，保证 history/done/busy 一定落地
        log.info(`[extract] ${this._logTag} seq=${this._runningSeq} 语法错误输出提取异常, 使用整窗输出: err=${e instanceof Error ? e.message : String(e)}`)
        out = this._buffer.slice(this._watchStartPos)
      }
      this._completeRunning(this._watchStartPos, this._buffer.length, null, this._watchCommand, out, "watch(syntax)")
      return
    }
    this._completeRunning(this._watchStartPos, o.markerPos ?? this._buffer.length, o.exitCode ?? null, this._watchCommand)
  }

  /**
   * 推进语法错误安静窗口（一次性定时器，非轮询）：识别到语法错误后等输出停止增长 SYNTAX_QUIET_MS 再收尾，
   * 确保 pwsh 异步/批量渲染的多行错误块被完整收进输出窗口；自首次识别起上限 SYNTAX_MAX_WAIT_MS。
   * 数据到达（输出变化）时重置安静窗口；兜底 tick 不重置（见 _checkCompletion）。
   * @returns 无
   */
  private _armSyntaxQuiet(): void {
    const now = Date.now()
    const len = this._buffer.length
    if (this._syntaxSeenAt === 0) {
      this._syntaxSeenAt = now
      this._syntaxQuietAt = now
      this._syntaxLen = len
    } else if (len !== this._syntaxLen) {
      this._syntaxLen = len
      this._syntaxQuietAt = now
    }
    if (now - this._syntaxSeenAt >= SYNTAX_MAX_WAIT_MS) {
      this._clearSyntaxTimer()
      this._settleCompletion({ kind: "done", exitCode: null, syntaxError: true })
      return
    }
    const remain = Math.max(0, SYNTAX_QUIET_MS - (now - this._syntaxQuietAt))
    this._clearSyntaxTimer()
    this._syntaxTimer = setTimeout(() => {
      this._syntaxTimer = null
      if (this._runningStartPos === null) return
      try {
        this._settleCompletion({ kind: "done", exitCode: null, syntaxError: true })
      } catch (e) {
        log.info(`[watch] ${this._logTag} seq=${this._runningSeq} 语法静默收尾异常: err=${e instanceof Error ? e.message : String(e)}`)
      }
    }, remain)
  }

  /**
   * 断连收尾（由后台兜底 tick 判定 _connected=false 触发）：命令视为结束（可能从未完成），
   * 补发 done 防 server busy 卡死；不写 history（输出窗口从未定案，无可信尾部可摘）。
   * @returns 无
   */
  private _handleDisconnect(): void {
    if (this._runningCommand) {
      this._emitDone(null, Date.now())
      // 断连收尾也是"结束"：补记 [run] 结束；不附 tail（输出窗口从未定案，无可信尾部可摘）
      log.info(`[run] 结束 ${this._logTag} seq=${this._runningSeq} endPos=${this._buffer.length} exitCode=null duration=${Date.now()-this._runningStartTs}ms reason=disconnect`)
    }
    this._setBusy(false, "断连补 done")
    this._clearRunningContext()
    if (this._watchTimer) {
      clearInterval(this._watchTimer)
      this._watchTimer = null
    }
  }

  /**
   * 开始一次命令的后台追踪：记录兜底判定所需的捕获窗口起点/命令，并复位语法静默状态。
   * 不做任何轮询——完成判定由数据到达事件驱动（见 `_onDataArrived`）。
   * @param startPos 捕获窗口起点（相对当前 buffer；submit 为 0，exec 转后台为 captureStart）
   * @param command 命令（history 记录用）
   * @returns 无
   */
  private _armTracking(startPos: number, command: string): void {
    this._watchStartPos = startPos
    this._watchCommand = command
    this._syntaxSeenAt = 0
    this._syntaxQuietAt = 0
    this._syntaxLen = 0
    this._clearSyntaxTimer()
  }

  /**
   * 启动稀疏兜底监听（≥1s，非高频轮询）：完成判定已由数据到达事件驱动，此定时器仅覆盖
   * 断连（子类只置 `_connected=false`、不回调基类）与极端漏判保护；命令已不在追踪中则不启动。
   * @returns 无
   */
  private _startFallbackWatch(): void {
    if (this._runningStartPos === null || !this._runningCommand) return
    if (this._watchTimer) return
    this._watchTimer = setInterval(() => { this._fallbackTick() }, FALLBACK_WATCH_INTERVAL_MS)
  }

  /** 后台兜底一次：断连优先处理，否则复用统一完成判定（异常不得让监听中断，否则 busy 卡死） */
  private _fallbackTick(): void {
    try {
      if (this._runningStartPos === null || !this._runningCommand) return
      if (!this._connected) {
        this._handleDisconnect()
        return
      }
      this._checkCompletion(false)
    } catch (e) {
      // tick 内异常：记一行后继续下一轮监听（完成判定仍只认当前 seq 标记）
      infoDedup(`tick-exc:${this._logTag}:${this._runningSeq}`, `[watch] ${this._logTag} seq=${this._runningSeq} tick 异常, 保持监听: err=${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 清除 exec 同步等待的 animation 一次性定时器（幂等） */
  private _clearAnimationTimer(): void {
    if (this._animationTimer) {
      clearTimeout(this._animationTimer)
      this._animationTimer = null
    }
  }

  /** 清除语法静默一次性定时器（幂等） */
  private _clearSyntaxTimer(): void {
    if (this._syntaxTimer) {
      clearTimeout(this._syntaxTimer)
      this._syntaxTimer = null
    }
  }

  /**
   * 统一命令完成收尾（供 exec 同步完成、后台 watch 与 readBuffer 复用，避免多处收尾逻辑漂移）：
   * 提取/追加 history、补发 done 事件、定位 cursor、翻转 busy、清 running 上下文、停后台 watch。
   * @param startPos 命令捕获窗口起点（相对 buffer；watch 的捕获起点与 _runningStartPos 可能不同，须显式传入）
   * @param endPos 完成位置（marker/中断回显在 buffer 中的偏移）
   * @param exitCode 退出码（语法错误收尾为 null，^C 为 130）
   * @param command 原始命令（history 记录用）
   * @param out 已提取的纯输出；缺省时由 [startPos, endPos) 窗口经 _extractOutput 提取
   * @param reason 完成来源（direct / direct(syntax) / watch / watch(syntax) / readBuffer），仅用于日志
   * @returns 本次完成窗口的原始片段（readBuffer 返回给调用方用）
   */
  private _completeRunning(startPos: number, endPos: number, exitCode: number | null, command: string, out?: string, reason = "watch"): string {
    const raw = this._buffer.slice(startPos, endPos)
    let output: string
    try {
      output = out ?? this._extractOutput(raw, command)
    } catch (e) {
      // 输出提取异常绝不影响收尾：退化为整窗原始输出，保证 history/done/busy 一定落地
      log.info(`[extract] ${this._logTag} seq=${this._runningSeq} 输出提取异常, 使用整窗输出: cmdLen=${command.length} err=${e instanceof Error ? e.message : String(e)}`)
      output = raw
    }
    this._history.append(command, output, this._runningStartTs, undefined, exitCode ?? undefined)
    this._emitDone(exitCode, Date.now(), output)
    this._cursor = Math.max(startPos, endPos)
    this._setBusy(false, "cmdDone", true) // 命令完成即清 busy（"保持 busy 到排队序列结束"的机制已移除）；释放行紧随 [run] 结束，降 debug 免重复
    // 结束日志：非内容信息（长度/耗时/退出码/原因）保持 info；有界输出尾部摘要降级为 debug，避免泄漏输出内容
    log.info(`[run] 结束 ${this._logTag} seq=${this._runningSeq} endPos=${endPos} exitCode=${exitCode} outLen=${output.length} duration=${Date.now()-this._runningStartTs}ms reason=${reason}`)
    if (isDebugEnabled()) {
      const outTail = tailSummary(output)
      if (outTail) debug(`[run] 结束 ${this._logTag} seq=${this._runningSeq} tail=${outTail}`)
    }
    this._stopInterruptCycle("命令完成")
    this._clearRunningContext()
    if (this._watchTimer) clearInterval(this._watchTimer)
    return raw
  }

  protected _clearRunningContext(): void {
    this._stopInterruptCycle("运行上下文清理")
    this._clearSyntaxTimer()
    this._clearAnimationTimer()
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

  /**
   * 日志身份前缀 `<主会话ID>/<终端名>`（会话/终端上下文的日志行统一带上，便于 `grep ses_xxx` 过滤）；
   * 需要命令坐标的行再自行追加 ` seq=<this._runningSeq>`。
   * @returns 形如 `ses_abc123/default` 的标签
   */
  protected get _logTag(): string {
    return `${this.sessionID}/${this.name}`
  }
}
