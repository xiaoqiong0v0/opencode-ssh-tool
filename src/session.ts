// SshSession：ssh2 长驻连接 + PTY shell 管理，
// OSC 不可见标记法：注入 PROMPT_COMMAND 脚本，命令完成时输出 \x1b]777;SSH;D;退出码\x07
// 子终端中无标记 → 视为仍在运行，子终端输入输出归入上一条命令

import { Client, type ConnectConfig } from "ssh2"
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
  READY_TIMEOUT_MS,
  SETTLE_TIMEOUT_MS,
} from "./constants.js"
import { resolveAuth, resolvePassword, type AuthInfo } from "./ssh-auth.js"
import { SessionHistory } from "./history.js"
import { toModelText, extractOutputStart, extractOutput } from "./utils.js"
import { detectDoneMarker, resolveByProbe, stripMarkers, type ShellAdapter } from "./shell-adapter.js"

/** 连接结果 */
export interface ConnectResult {
  ok: boolean
  host?: string
  user?: string
  port?: number
  error?: string
}

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

/** 会话状态（供 ssh_status） */
export interface SessionStatus {
  connected: boolean
  busy: boolean
  pending: number
  name?: string
  host?: string
  user?: string
  port?: number
  lastActive?: number
  connectedAt?: number
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

export class SshSession {
  private _client: Client | null = null
  private _stream: import("ssh2").ClientChannel | null = null
  private _connected = false
  private _remoteBusy = false
  private _buffer = ""
  private _host = ""
  private _user = ""
  private _port = 22
  private _connectedAt = 0
  private _lastActive = 0
  private _runningStartPos: number | null = null
  private _runningCommand = ""
  private _watchTimer: ReturnType<typeof setInterval> | null = null
  private _cursor = 0
  private _streamPos: number | null = null
  private _closed = false
  private readonly _history: SessionHistory
  private _adapter: ShellAdapter | null = null
  /** 连续原始字节流（从 PTY 首字节起累积，含欢迎页/探测/注入/提示符/marker）；ring 裁剪 */
  private _rawLog = ""
  /** 已裁剪丢弃的字符数（前端 pos 同步用） */
  private _rawDiscarded = 0
  /** 累积原始字节总数（单调递增，前端增量游标） */
  private _rawTotal = 0

  constructor(
    private readonly sessionID: string,
    history: SessionHistory,
    private readonly name = "default",
  ) {
    this._history = history
  }

  /**
   * 建立 SSH 连接并打开 PTY shell，探测 shell 类型后注入 OSC 标记脚本
   * @param opts 连接参数；显式传 password 时优先用密码认证，否则回退 resolveAuth（私钥/agent/环境变量）
   * @returns 连接结果
   */
  async connect(opts: { host: string; user: string; port?: number; password?: string }): Promise<ConnectResult> {
    const port = opts.port ?? 22
    let auth: AuthInfo
    if (opts.password) {
      const pw = resolvePassword(opts.password)
      auth = pw ? { password: pw } : resolveAuth(opts.host)
    } else {
      auth = resolveAuth(opts.host)
    }
    const config: ConnectConfig = {
      host: opts.host,
      port,
      username: opts.user,
      readyTimeout: READY_TIMEOUT_MS,
      debug: (msg: string) => log.info(`[ssh2] ${msg}`),
      ...auth,
    }

    const client = new Client()
    let settled = false

    return new Promise<ConnectResult>((resolve) => {
      const fail = (msg: string) => {
        if (settled) return
        settled = true
        log.error(`连接失败 ${opts.host}`, msg)
        resolve({ ok: false, host: opts.host, user: opts.user, port, error: msg })
      }

      // 常驻错误监听：ssh2 可能多次发 error（断线/通道异常），once 首次触发后失效会变 unhandled
      client.on("error", (err: Error) => {
        if (!settled) {
          fail(err.message)
          return
        }
        log.error(`SSH 会话错误 ${opts.host}`, err)
        // 连接已建立后的错误：标记断开并清理运行态，避免悬空
        this._connected = false
        this._remoteBusy = false
        this._clearRunningContext()
        if (this._watchTimer) {
          clearInterval(this._watchTimer)
          this._watchTimer = null
        }
      })

      client.once("ready", () => {
        client.shell(
          { rows: PTY_ROWS, cols: PTY_COLS, term: "xterm-256color" },
          (err: Error | undefined, stream) => {
            if (err || !stream) {
              client.end()
              fail(err?.message ?? "shell open failed")
              return
            }
            settled = true
            this._client = client
            this._stream = stream
            this._connected = true
            this._host = opts.host
            this._user = opts.user
            this._port = port
            this._connectedAt = Date.now()
            this._lastActive = Date.now()

            stream.on("data", (chunk: Buffer) => {
              this._appendBuffer(chunk.toString())
            })
            stream.on("close", () => {
              this._connected = false
              this._remoteBusy = false
            })
            stream.on("error", (e: Error) => {
              log.error("PTY stream 错误", e)
              this._connected = false
            })

            // 等待登录 banner / 初始提示符稳定后探测 shell 并注入脚本
            ;(async () => {
              await new Promise((r) => setTimeout(r, 400))
              this._buffer = ""
              this._cursor = 0
              this._runningStartPos = null
              log.info(`连接成功 ${opts.user}@${opts.host}:${port} (session ${this.sessionID})`)

              // 已有历史则清空重来（重连视为全新开始）
              if (this._history.totalPairs() > 0) {
                this._history.clear()
              }

              // 总时限：shell 从启动到完成标记注入确认，超时判定连接失败
              const deadline = Date.now() + INJECT_TIMEOUT_MS

              const adapter = await this._probeShell(deadline)
              if (!adapter) {
                log.error(`Shell 探测超时，终止连接 ${opts.user}@${opts.host}`)
                this.close()
                resolve({ ok: false, host: opts.user, user: opts.user, port, error: "Shell 探测超时（30s 内 shell 未就绪），连接终止" })
                return
              }
              this._adapter = adapter
              log.info(`Shell 探测结果: ${this._adapter.name}`)

              const injected = await this._injectAndSettle(deadline)
              if (!injected) {
                log.error(`标记注入超时终止连接 ${opts.user}@${opts.host}`)
                this.close()
                resolve({ ok: false, host: opts.user, user: opts.user, port, error: "完成标记注入超时（shell 未就绪或启动过慢），连接终止" })
                return
              }
              this._buffer = ""
              this._cursor = 0

              resolve({ ok: true, host: opts.user, user: opts.user, port })
            })()
          },
        )
      })

      client.connect(config)
    })
  }

  /** 探测 shell 类型：deadline 内循环发送探测命令并解析输出（shell 慢启动时也能等到就绪） */
  private async _probeShell(deadline: number): Promise<ShellAdapter | null> {
    while (Date.now() < deadline) {
      this._stream!.write("echo __SHELL_ID__$0\r")
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
        if (line.trim()) this._stream!.write(line + "\r")
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

  async submit(command: string): Promise<ExecResult> {
    const startTs = Date.now()
    if (!this._connected || !this._stream || !this._adapter) {
      return { ok: false, output: "", error: "Not connected" }
    }
    if (this._remoteBusy) {
      return { ok: false, output: "", error: "Previous command still running, poll with ssh_status first" }
    }

    this._buffer = this._buffer.slice(this._cursor)
    const startPos = 0
    this._runningStartPos = startPos
    this._runningCommand = command
    this._remoteBusy = true
    this._lastActive = startTs
    this._stream.write(command + "\r")
    this._startBackgroundWatch(startPos, command)

    return { ok: true, output: "", submitted: true, host: this._host, command, duration: 0 }
  }

  async exec(command: string, timeout: number = EXEC_TIMEOUT_MS): Promise<ExecResult> {
    const startTs = Date.now()
    if (!this._connected || !this._stream || !this._adapter) {
      return { ok: false, output: "", error: "Not connected" }
    }
    if (this._remoteBusy) {
      return { ok: false, output: "", error: "Previous command still running, poll with ssh_status first" }
    }

    this._buffer = this._buffer.slice(this._cursor)
    const startPos = 0
    this._runningCommand = command
    this._remoteBusy = true
    this._lastActive = startTs
    this._stream.write(command + "\r")

    const outcome = await this._waitCompletion(startPos, timeout, startTs)

    switch (outcome.kind) {
      case "done": {
        this._remoteBusy = false
        const raw = this._buffer.slice(startPos, outcome.markerPos ?? this._buffer.length)
        this._cursor = Math.max(startPos, outcome.markerPos ?? this._buffer.length)
        this._history.append(command, extractOutput(raw, command))
        this._clearRunningContext()
        return { ok: true, output: this._truncate(toModelText(extractOutput(raw, command))), host: this._host, command, duration: Date.now() - startTs }
      }
      case "interactive": {
        this._remoteBusy = false
        const raw = this._buffer.slice(startPos)
        this._cursor = this._buffer.length
        this._history.append(command, raw)
        this._clearRunningContext()
        return { ok: true, output: this._truncate(toModelText(extractOutput(raw, command))), interactive: true, host: this._host, command, duration: Date.now() - startTs }
      }
      case "running":
      case "timeout": {
        this._runningStartPos = startPos
        this._remoteBusy = true
        this._startBackgroundWatch(startPos, command)
        const raw = this._buffer.slice(startPos)
        return { ok: true, output: this._truncate(toModelText(extractOutput(raw, command))), running: outcome.kind === "running", timeout: outcome.kind === "timeout", host: this._host, command, duration: Date.now() - startTs }
      }
    }
  }

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

  send(text: string): { ok: boolean; error?: string } {
    if (!this._connected || !this._stream) return { ok: false, error: "Not connected" }
    const payload = text
      .replace(/\\x1b/gi, "\x1b")
      .replace(/\\x03/gi, "\x03")
      .replace(/\\x04/gi, "\x04")
      .replace(/\\x1a/gi, "\x1a")
      .replace(/\\r/g, "\r")
      .replace(/\\n/g, "\r")
    this._stream.write(payload)
    this._lastActive = Date.now()
    return { ok: true }
  }

  getStatus(): SessionStatus {
    return {
      connected: this._connected,
      busy: this._connected && this._remoteBusy,
      pending: this._buffer.length,
      name: this.name,
      host: this._host,
      user: this._user,
      port: this._port,
      lastActive: this._lastActive,
      connectedAt: this._connectedAt,
    }
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

  close(): void {
    if (this._closed) return
    this._closed = true
    if (this._watchTimer) clearInterval(this._watchTimer)
    if (this._stream) { try { this._stream.end() } catch { /* 忽略 */ } }
    if (this._client) { try { this._client.end() } catch { /* 忽略 */ } }
    this._connected = false
    this._remoteBusy = false
    this._history.dispose()
    log.hook("ssh_disconnect", `关闭会话 ${this._host}`)
  }

  private _appendBuffer(text: string): void {
    this._buffer += text
    if (this._buffer.length > MAX_BUFFER_LEN) {
      const trimmed = this._buffer.length - MAX_BUFFER_LEN
      this._buffer = this._buffer.slice(trimmed)
      if (this._runningStartPos !== null) this._runningStartPos = Math.max(0, this._runningStartPos - trimmed)
      this._cursor = Math.max(0, this._cursor - trimmed)
      if (this._streamPos !== null) this._streamPos = Math.max(0, this._streamPos - trimmed)
      log.info(`buffer 超限截断 ${trimmed} 字符，当前 ${this._buffer.length}`)
    }
    this._rawLog += text
    this._rawTotal += text.length
    if (this._rawLog.length > RAW_LOG_MAX) {
      const trimmed = this._rawLog.length - RAW_LOG_MAX
      this._rawLog = this._rawLog.slice(trimmed)
      this._rawDiscarded += trimmed
    }
  }

  /** 增量读取连续原始字节流 */
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