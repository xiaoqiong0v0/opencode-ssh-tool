// BaseSession：SSH(SshSession) 与本地(LocalSession) 终端的公共基类
// 统一完成标记法：注入 PROMPT_COMMAND 脚本，命令完成时输出 <SSH_DONE:退出码>
// 子类仅需实现：连接建立(connect)、数据写入(_write)、传输层清理(_closeTransport)、状态字段(getStatus)

import {
  ANIMATION_WINDOW_MS,
  EXEC_TIMEOUT_MS,
  MAX_OUTPUT_LEN,
  QUIET_WINDOW_MS,
  RAW_LOG_MAX,
  SETTLE_TIMEOUT_MS,
} from "./constants.js"
import log from "./log.js"
import { SessionHistory } from "./history.js"
import { toModelText, extractOutputStart, extractOutput } from "./utils.js"
import { detectDoneMarker, resolveByProbe, stripMarkers, type ShellAdapter } from "./shell-adapter.js"

/** 命令执行结果 */
export interface ExecResult {
  ok: boolean
  output: string
  interactive?: boolean
  running?: boolean
  timeout?: boolean
  submitted?: boolean
  error?: string
  host?: string
  command?: string
  duration?: number
}

/** 交互触发词（sudo 密码 / 分页器 / 确认提示），含中英文 */
const INTERACTIVE_RE =
  /(\[sudo\] password for|password for \S+:|Password:|密码:|--More--|\(END\)|\[y\/N\]|\[Y\/n\]|yes\/no|是\/否)/i

/** buffer 最大长度（未消费输出超限时截断头部，防内存膨胀） */
const MAX_BUFFER_LEN = 2 * 1024 * 1024

/** 后台监听最长存活时间（防泄漏） */
const MAX_WATCH_LEN = 10 * 60_000

/** Shell 探测等待超时 */
const PROBE_TIMEOUT_MS = 5_000

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
  /** 下次捕获窗口起点（相对当前 buffer）：前一条命令结束后，标记/残留从此处开始 */
  protected _cursor = 0
  /** WS 实时流已发送位置（相对 buffer 偏移）；null = 尚未定位命令回显结束点 */
  protected _streamPos: number | null = null
  /** Shell 适配器（探测后确定） */
  protected _adapter: ShellAdapter | null = null
  protected _closed = false
  /** 连续原始字节流（从首字节起累积，含欢迎页/探测/注入/提示符/marker）；ring 裁剪 */
  private _rawLog = ""
  /** 已裁剪丢弃的字符数（前端 pos 同步用） */
  private _rawDiscarded = 0
  /** 累积原始字节总数（单调递增，前端增量游标） */
  private _rawTotal = 0
  protected readonly _history: SessionHistory

  constructor(
    protected readonly sessionID: string,
    history: SessionHistory,
    protected readonly name = "default",
  ) {
    this._history = history
  }

  /** 向传输层写入字节（子类实现：SSH 写 stream / 本地写 Bun.Terminal） */
  protected abstract _write(data: string): void
  /** 关闭传输层资源（子类实现：SSH 关 client+stream / 本地关 term+proc） */
  protected abstract _closeTransport(): void
  /** 结果中的类型专属字段（SSH 附加 host，本地为空） */
  protected get _extraResult(): Partial<ExecResult> { return {} }
  /** 忙碌提示中的状态命令名（ssh_status / local_status） */
  protected abstract _statusCmd: string

  /**
   * 异步提交命令：立即返回，命令后台执行，输出由后台监听收集进 history
   * @param command 命令
   * @returns 提交结果（立即返回，不等待命令完成）
   */
  async submit(command: string): Promise<ExecResult> {
    if (!this._ready()) return { ok: false, output: "", error: "Not connected" }
    if (this._remoteBusy) return { ok: false, output: "", error: `Previous command still running, poll with ${this._statusCmd} first` }

    this._beginCapture(command)
    this._write(command + "\r")
    this._startBackgroundWatch(0, command)

    return { ok: true, output: "", submitted: true, command, duration: 0, ...this._extraResult }
  }

  /**
   * 在当前终端执行命令（同步等待），保留 cwd/环境
   * @param command 命令
   * @param timeout 超时毫秒，默认 30s
   * @returns 执行结果
   */
  async exec(command: string, timeout: number = EXEC_TIMEOUT_MS): Promise<ExecResult> {
    const startTs = Date.now()
    if (!this._ready()) return { ok: false, output: "", error: "Not connected" }
    if (this._remoteBusy) return { ok: false, output: "", error: `Previous command still running, poll with ${this._statusCmd} first` }

    this._beginCapture(command)
    this._write(command + "\r")

    const outcome = await this._waitCompletion(0, timeout, startTs)

    switch (outcome.kind) {
      case "done": {
        this._remoteBusy = false
        const raw = this._buffer.slice(0, outcome.markerPos ?? this._buffer.length)
        this._cursor = Math.max(0, outcome.markerPos ?? this._buffer.length)
        this._history.append(command, extractOutput(raw, command))
        this._clearRunningContext()
        return { ok: true, output: this._truncate(toModelText(extractOutput(raw, command))), command, duration: Date.now() - startTs, ...this._extraResult }
      }
      case "interactive": {
        this._remoteBusy = false
        const raw = this._buffer.slice(0)
        this._cursor = this._buffer.length
        this._history.append(command, raw)
        this._clearRunningContext()
        return { ok: true, output: this._truncate(toModelText(extractOutput(raw, command))), interactive: true, command, duration: Date.now() - startTs, ...this._extraResult }
      }
      case "running":
      case "timeout": {
        this._runningStartPos = 0
        this._remoteBusy = true
        this._startBackgroundWatch(0, command)
        const raw = this._buffer.slice(0)
        return { ok: true, output: this._truncate(toModelText(extractOutput(raw, command))), running: outcome.kind === "running", timeout: outcome.kind === "timeout", command, duration: Date.now() - startTs, ...this._extraResult }
      }
    }
  }

  /**
   * 读取并清空未消费缓冲（交互/轮询场景）
   * @returns 未消费输出
   */
  async readBuffer(): Promise<{ ok: boolean; output: string; error?: string }> {
    if (!this._connected) return { ok: false, output: "", error: "Not connected" }
    let out: string
    if (this._runningStartPos !== null && this._runningCommand) {
      const end = extractOutputStart(this._buffer.slice(this._runningStartPos), this._runningCommand)
      const marker = end > 0
        ? detectDoneMarker(this._buffer, this._runningStartPos + end)
        : { done: false, exitCode: 0, pos: 0 }
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
    return { ok: true, output: this._truncate(toModelText(out)) }
  }

  /**
   * 发送文本/按键到终端（交互场景：sudo 密码、确认、中断等）
   * 转义序列：\r 或 \n = 回车，\x03 = Ctrl-C，\x04 = Ctrl-D，\x1a = Ctrl-Z，\x1b = ESC
   * @param text 要发送的文本或按键序列
   * @returns 是否发送成功
   */
  send(text: string): { ok: boolean; error?: string } {
    if (!this._connected) return { ok: false, error: "Not connected" }
    const payload = text
      .replace(/\\x1b/gi, "\x1b")
      .replace(/\\x03/gi, "\x03")
      .replace(/\\x04/gi, "\x04")
      .replace(/\\x1a/gi, "\x1a")
      .replace(/\\r/g, "\r")
      .replace(/\\n/g, "\r")
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
    const end = extractOutputStart(this._buffer.slice(this._runningStartPos), this._runningCommand)
    if (end <= 0) return { data: "", done: false }
    const echoEnd = this._runningStartPos + end
    const marker = detectDoneMarker(this._buffer, echoEnd)
    const windowEnd = marker.done ? marker.pos : this._buffer.length
    if (this._streamPos === null) {
      this._streamPos = echoEnd
    }
    const raw = this._buffer.slice(this._streamPos, windowEnd)
    this._streamPos = windowEnd
    return { data: stripMarkers(raw), done: marker.done }
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

  /** 命令执行/提交前准备：裁剪已消费缓冲 + 丢弃上一条命令的迟到残留标记 */
  private _beginCapture(command: string): void {
    this._buffer = this._buffer.slice(this._cursor)
    this._cursor = 0
    const stale = detectDoneMarker(this._buffer, 0)
    if (stale.done) {
      this._buffer = this._buffer.slice(stale.pos)
    }
    this._runningStartPos = 0
    this._runningCommand = command
    this._remoteBusy = true
    this._lastActive = Date.now()
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

  /** 探测 shell 类型：deadline 内循环发送探测命令并解析输出（shell 慢启动时也能等到就绪） */
  protected async _probeShell(deadline: number): Promise<ShellAdapter | null> {
    while (Date.now() < deadline) {
      this._write("echo __SHELL_ID__$0\r")
      const output = await this._waitProbeOutput(Math.min(PROBE_TIMEOUT_MS, deadline - Date.now()))
      if (output !== null && /\b__SHELL_ID__\b/.test(output)) {
        const adapter = resolveByProbe(output)
        this._buffer = ""
        return adapter
      }
      this._buffer = ""
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
   * deadline 内循环注入+等待完成标记，成功返回 true，超时返回 false
   * 逐行发送避免因 shell 未就绪导致的整块丢失；每轮等待标记最大 3s
   */
  protected async _injectAndSettle(deadline: number): Promise<boolean> {
    const lines = this._adapter!.injectScript.split("\n")
    while (Date.now() < deadline) {
      for (const line of lines) {
        if (line.trim()) this._write(line + "\r")
      }
      if (await this._waitForMarker(Math.min(SETTLE_TIMEOUT_MS, deadline - Date.now()))) {
        // 标记确认后吸收迟到输出（最后一条注入命令的提示符残留等），保证后续命令从干净缓冲开始
        await new Promise((r) => setTimeout(r, 100))
        this._buffer = ""
        this._cursor = 0
        return true
      }
      log.info("完成标记注入未确认，重试")
      this._buffer = ""
      this._cursor = 0
    }
    return false
  }

  /** 等待标记出现（最多 maxMs） */
  private async _waitForMarker(maxMs: number): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < maxMs) {
      if (detectDoneMarker(this._buffer, 0).done) return true
      await new Promise((r) => setTimeout(r, 50))
    }
    return false
  }

  private _waitCompletion(
    startPos: number,
    timeout: number,
    startTs: number,
  ): Promise<{ kind: "done" | "interactive" | "running" | "timeout"; markerPos?: number }> {
    return new Promise((resolve) => {
      let lastLen = this._buffer.length
      let lastChange = Date.now()
      let echoEnd = 0
      const timer = setInterval(() => {
        if (INTERACTIVE_RE.test(this._buffer.slice(startPos))) {
          clearInterval(timer)
          resolve({ kind: "interactive" })
          return
        }
        const now = Date.now()
        const curLen = this._buffer.length
        if (curLen !== lastLen) {
          lastLen = curLen
          lastChange = now
        }
        if (echoEnd <= 0 && this._runningCommand) {
          const end = extractOutputStart(this._buffer.slice(startPos), this._runningCommand)
          if (end > 0) echoEnd = startPos + end
        }
        // 完成标记（精确权威）：命令结束时 shell 重绘提示符前必输出 <SSH_DONE>，
        // 下载/编译等静默期不会误判完成，中断（Ctrl-C 回到提示符）同样会输出标记。
        // 必须等命令回显出现后才检测：回显前的标记只可能是上一条命令的迟到残留。
        if (echoEnd > 0) {
          const marker = detectDoneMarker(this._buffer, echoEnd)
          if (marker.done) {
            clearInterval(timer)
            resolve({ kind: "done", markerPos: marker.pos })
            return
          }
        }
        if (now - lastChange < QUIET_WINDOW_MS && now - startTs >= ANIMATION_WINDOW_MS) {
          clearInterval(timer)
          resolve({ kind: "running" })
          return
        }
        if (now - startTs >= timeout) {
          clearInterval(timer)
          resolve({ kind: "timeout" })
          return
        }
      }, 50)
    })
  }

  /** 后台监听：轮询 done 标记 → 收集输出进 history + busy=false */
  private _startBackgroundWatch(startPos: number, command: string): void {
    if (this._watchTimer) clearInterval(this._watchTimer)
    const born = Date.now()
    let echoEnd = 0
    this._watchTimer = setInterval(() => {
      if (!this._connected || Date.now() - born > MAX_WATCH_LEN) {
        this._remoteBusy = false
        this._clearRunningContext()
        if (this._watchTimer) clearInterval(this._watchTimer)
        return
      }
      if (echoEnd <= 0 && command) {
        const end = extractOutputStart(this._buffer.slice(startPos), command)
        if (end > 0) echoEnd = startPos + end
      }
      if (echoEnd <= 0) return
      const marker = detectDoneMarker(this._buffer, echoEnd)
      if (marker.done) {
        const raw = this._buffer.slice(startPos, marker.pos)
        this._history.append(command, extractOutput(raw, command))
        this._cursor = Math.max(startPos, marker.pos)
        this._remoteBusy = false
        this._clearRunningContext()
        if (this._watchTimer) clearInterval(this._watchTimer)
      }
    }, 200)
  }

  protected _clearRunningContext(): void {
    this._runningStartPos = null
    this._runningCommand = ""
    this._streamPos = null
  }

  private _truncate(s: string): string {
    if (s.length <= MAX_OUTPUT_LEN) return s
    return `${s.slice(0, MAX_OUTPUT_LEN)}\n... [output truncated, ${s.length} chars total]`
  }
}
