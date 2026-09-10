// LocalSession：基于 Bun.Terminal 的本地/容器 PTY 会话（本地 shell、docker exec -it 等），
// OSC 不可见标记法：注入 PROMPT_COMMAND 脚本，命令完成时输出 \x1b]777;SSH;D;退出码\x07
// 子终端中无标记 → 视为仍在运行，子终端输入输出归入上一条命令
// 支持交互（sudo 密码/确认/中断）

import log from "./log.js"
import {
  ANIMATION_WINDOW_MS,
  EXEC_TIMEOUT_MS,
  INJECT_TIMEOUT_MS,
  MAX_OUTPUT_LEN,
  PTY_COLS,
  PTY_ROWS,
  QUIET_WINDOW_MS,
  RAW_LOG_MAX,
  SETTLE_TIMEOUT_MS,
} from "./constants.js"
import { SessionHistory } from "./history.js"
import { toModelText, extractOutputStart, extractOutput } from "./utils.js"
import { detectDoneMarker, resolveByProbe, stripMarkers, type ShellAdapter } from "./shell-adapter.js"

/** 命令执行结果 */
export interface LocalExecResult {
  ok: boolean
  output: string
  interactive?: boolean
  running?: boolean
  timeout?: boolean
  submitted?: boolean
  error?: string
  command?: string
  duration?: number
}

/** 会话状态 */
export interface LocalStatus {
  connected: boolean
  busy: boolean
  pending: number
  name?: string
  program?: string
  lastActive?: number
  connectedAt?: number
}

/** 交互触发词（sudo 密码 / 分页器 / 确认提示），含中英文 */
const INTERACTIVE_RE =
  /(\[sudo\] password for|password for \S+:|Password:|密码:|--More--|\(END\)|\[y\/N\]|\[Y\/n\]|yes\/no|是\/否)/i

/**
 * 命令行字符串拆分为参数数组（Bun.spawn 要求数组形式；支持双/单引号分组）
 * @param cmd 命令行字符串，如 "docker exec -it myctr bash"
 * @returns 参数数组
 */
function splitCommand(cmd: string): string[] {
  const args: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(cmd))) args.push(m[1] ?? m[2] ?? m[3])
  return args
}

/** buffer 最大长度（未消费输出超限时截断头部，防内存膨胀） */
const MAX_BUFFER_LEN = 2 * 1024 * 1024

/** 后台监听最长存活时间（防泄漏） */
const MAX_WATCH_LEN = 10 * 60_000

/** Shell 探测等待超时 */
const PROBE_TIMEOUT_MS = 5_000

export class LocalSession {
  private _term: Bun.Terminal | null = null
  private _proc: Bun.Subprocess | null = null
  private _connected = false
  private _remoteBusy = false
  private _buffer = ""
  private _program = ""
  private _connectedAt = 0
  private _lastActive = 0
  private _runningStartPos: number | null = null
  private _runningCommand = ""
  private _watchTimer: ReturnType<typeof setInterval> | null = null
  /** 下次捕获窗口起点（相对当前 buffer）：前一条命令结束后，标记/残留从此处开始 */
  private _cursor = 0
  /** WS 实时流已发送位置（相对 buffer 偏移）；null = 尚未定位命令回显结束点 */
  private _streamPos: number | null = null
  /** Shell 适配器（探测后确定） */
  private _adapter: ShellAdapter | null = null
  private _closed = false
  /** 连续原始字节流（从 PTY 首字节起累积，含欢迎页/探测/注入/提示符/marker）；ring 裁剪 */
  private _rawLog = ""
  /** 已裁剪丢弃的字符数（前端 pos 同步用） */
  private _rawDiscarded = 0
  /** 累积原始字节总数（单调递增，前端增量游标） */
  private _rawTotal = 0
  private readonly _history: SessionHistory

  constructor(
    private readonly sessionID: string,
    history: SessionHistory,
    private readonly name = "default",
  ) {
    this._history = history
  }

  /**
   * 启动本地/容器 PTY 终端，探测 shell 类型后注入 OSC 标记脚本
   * @param opts 命令（如 "pwsh" / "docker exec -it <容器> bash"）与工作目录
   * @returns 是否启动成功
   */
  async connect(opts: { command: string; cwd?: string }): Promise<{ ok: boolean; error?: string }> {
    try {
      const term = new Bun.Terminal({
        cols: PTY_COLS,
        rows: PTY_ROWS,
        name: "xterm-256color",
        data: (_t, d) => this._appendBuffer(new TextDecoder().decode(d)),
        exit: () => {
          this._connected = false
          this._remoteBusy = false
        },
      })
      const proc = Bun.spawn(splitCommand(opts.command), { terminal: term, cwd: opts.cwd })
      this._term = term
      this._proc = proc
      this._program = opts.command
      this._connected = true
      this._connectedAt = Date.now()
      this._lastActive = Date.now()
      // 等待初始 banner/提示符稳定后清空 buffer（不算业务输出）
      await new Promise((r) => setTimeout(r, 400))
      this._buffer = ""
      this._cursor = 0
      this._runningStartPos = null
      log.info(`本地终端启动 ${opts.command} (session ${this.sessionID}, term ${this.name})`)

      // 已有历史则清空重来（重连视为全新开始）
      if (this._history.totalPairs() > 0) {
        this._history.clear()
      }

      // 总时限：shell 从启动到完成标记注入确认（含探测与重试），超时判定连接失败
      const deadline = Date.now() + INJECT_TIMEOUT_MS

      // 探测 shell 类型（deadline 内重试，避免慢启动错配默认适配器）
      const adapter = await this._probeShell(deadline)
      if (!adapter) {
        log.error("Shell 探测超时，连接终止")
        this.close()
        return { ok: false, error: "Shell 探测超时（30s 内 shell 未就绪），连接终止" }
      }
      this._adapter = adapter
      log.info(`Shell 探测结果: ${this._adapter.name}`)

      // 注入完成标记脚本（deadline 内重试，超时断连）
      const injected = await this._injectAndSettle(deadline)
      if (!injected) {
        this.close()
        return { ok: false, error: "完成标记注入超时（shell 未就绪或启动过慢），连接终止" }
      }
      this._buffer = ""
      this._cursor = 0

      return { ok: true }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log.error(`本地终端启动失败 ${opts.command}`, msg)
      this.close()
      return { ok: false, error: msg }
    }
  }

  /** 探测 shell 类型：deadline 内循环发送探测命令并解析输出（shell 慢启动时也能等到就绪） */
  private async _probeShell(deadline: number): Promise<ShellAdapter | null> {
    while (Date.now() < deadline) {
      this._term!.write("echo __SHELL_ID__$0\r")
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
  private async _injectAndSettle(deadline: number): Promise<boolean> {
    const lines = this._adapter!.injectScript.split("\n")
    while (Date.now() < deadline) {
      for (const line of lines) {
        if (line.trim()) this._term!.write(line + "\r")
      }
      if (await this._waitForMarker(Math.min(SETTLE_TIMEOUT_MS, deadline - Date.now()))) return true
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

  /**
   * 异步提交命令：立即返回，命令后台执行，输出由后台监听收集进 history
   * @param command 命令
   * @returns 提交结果（立即返回，不等待命令完成）
   */
  async submit(command: string): Promise<LocalExecResult> {
    const startTs = Date.now()
    if (!this._connected || !this._term || !this._adapter) return { ok: false, output: "", error: "Not connected" }
    if (this._remoteBusy) return { ok: false, output: "", error: "Previous command still running, poll with local_status first" }

    this._buffer = this._buffer.slice(this._cursor)
    const startPos = 0
    this._runningStartPos = startPos
    this._runningCommand = command
    this._remoteBusy = true
    this._lastActive = startTs
    this._term.write(command + "\r")
    this._startBackgroundWatch(startPos, command)

    return { ok: true, output: "", submitted: true, command, duration: 0 }
  }

  /**
   * 在当前终端执行命令（同步等待），保留 cwd/环境
   * @param command 命令
   * @param timeout 超时毫秒，默认 30s
   * @returns 执行结果
   */
  async exec(command: string, timeout: number = EXEC_TIMEOUT_MS): Promise<LocalExecResult> {
    const startTs = Date.now()
    if (!this._connected || !this._term || !this._adapter) return { ok: false, output: "", error: "Not connected" }
    if (this._remoteBusy) return { ok: false, output: "", error: "Previous command still running, poll with local_status first" }

    this._buffer = this._buffer.slice(this._cursor)
    const startPos = 0
    this._runningCommand = command
    this._remoteBusy = true
    this._lastActive = startTs
    this._term.write(command + "\r")

    const outcome = await this._waitCompletion(startPos, timeout, startTs)

    switch (outcome.kind) {
      case "done": {
        this._remoteBusy = false
        const raw = this._buffer.slice(startPos, outcome.markerPos ?? this._buffer.length)
        this._cursor = Math.max(startPos, outcome.markerPos ?? this._buffer.length)
        this._history.append(command, extractOutput(raw, command))
        this._clearRunningContext()
        return { ok: true, output: this._truncate(toModelText(extractOutput(raw, command))), command, duration: Date.now() - startTs }
      }
      case "interactive": {
        this._remoteBusy = false
        const raw = this._buffer.slice(startPos)
        this._cursor = this._buffer.length
        this._history.append(command, raw)
        this._clearRunningContext()
        return { ok: true, output: this._truncate(toModelText(extractOutput(raw, command))), interactive: true, command, duration: Date.now() - startTs }
      }
      case "running":
      case "timeout": {
        this._runningStartPos = startPos
        this._remoteBusy = true
        this._startBackgroundWatch(startPos, command)
        const raw = this._buffer.slice(startPos)
        return { ok: true, output: this._truncate(toModelText(extractOutput(raw, command))), running: outcome.kind === "running", timeout: outcome.kind === "timeout", command, duration: Date.now() - startTs }
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
    if (this._runningStartPos !== null) {
      const marker = detectDoneMarker(this._buffer, this._runningStartPos)
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
    if (!this._connected || !this._term) return { ok: false, error: "Not connected" }
    const payload = text
      .replace(/\\x1b/gi, "\x1b")
      .replace(/\\x03/gi, "\x03")
      .replace(/\\x04/gi, "\x04")
      .replace(/\\x1a/gi, "\x1a")
      .replace(/\\r/g, "\r")
      .replace(/\\n/g, "\r")
    this._term.write(payload)
    this._lastActive = Date.now()
    return { ok: true }
  }

  /**
   * 获取会话状态
   * @returns 状态对象
   */
  getStatus(): LocalStatus {
    return {
      connected: this._connected,
      busy: this._connected && this._remoteBusy,
      pending: this._buffer.length,
      name: this.name,
      program: this._program,
      lastActive: this._lastActive,
      connectedAt: this._connectedAt,
    }
  }

  getHistory(): SessionHistory { return this._history }

  getRunningOutput(): string {
    if (this._runningStartPos === null || !this._connected || !this._runningCommand) return ""
    return this._buffer.slice(this._runningStartPos)
  }

  hasRunningStream(): boolean {
    return this._runningStartPos !== null && this._connected && this._runningCommand !== ""
  }

  getRunningCommand(): string {
    return this._runningStartPos !== null && this._connected ? this._runningCommand : ""
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
    const marker = detectDoneMarker(this._buffer, this._runningStartPos)
    const windowEnd = marker.done ? marker.pos : this._buffer.length
    if (this._streamPos === null) {
      const start = extractOutputStart(this._buffer.slice(this._runningStartPos, windowEnd), this._runningCommand)
      if (start <= 0) return { data: "", done: false }
      this._streamPos = this._runningStartPos + start
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
    try { this._term?.close() } catch { /* 忽略 */ }
    try { this._proc?.kill() } catch { /* 忽略 */ }
    this._connected = false
    this._remoteBusy = false
    this._history.dispose()
    log.hook("local_disconnect", `关闭本地终端 ${this._program}`)
  }

  private _appendBuffer(text: string): void {
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

  /** 增量读取连续原始字节流：返回自 pos 之后的新增字节 */
  readRawStream(pos: number): { data: string; pos: number; reset?: boolean } {
    if (pos < this._rawDiscarded) return { data: this._rawLog, pos: this._rawTotal, reset: true }
    const from = pos - this._rawDiscarded
    return { data: this._rawLog.slice(from), pos: this._rawTotal }
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
        // 下载/编译等静默期不会误判完成，中断（Ctrl-C 回到提示符）同样会输出标记
        const marker = detectDoneMarker(this._buffer, echoEnd > 0 ? echoEnd : startPos)
        if (marker.done) {
          clearInterval(timer)
          resolve({ kind: "done", markerPos: marker.pos })
          return
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

  /** 后台监听：轮询 OSC done 标记 → 收集输出进 history + busy=false */
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
      const marker = detectDoneMarker(this._buffer, echoEnd > 0 ? echoEnd : startPos)
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

  private _clearRunningContext(): void {
    this._runningStartPos = null
    this._runningCommand = ""
    this._streamPos = null
  }

  private _truncate(s: string): string {
    if (s.length <= MAX_OUTPUT_LEN) return s
    return `${s.slice(0, MAX_OUTPUT_LEN)}\n... [output truncated, ${s.length} chars total]`
  }
}