// SshSession：ssh2 长驻连接 + PTY shell 管理，提供哨兵法命令执行与状态查询

import { Client, type ConnectConfig } from "ssh2"
import createLogger from "@xiaoqiong0v0/opencode-plugin-logger"
import {
  ANIMATION_WINDOW_MS,
  EXEC_TIMEOUT_MS,
  MAX_OUTPUT_LEN,
  PTY_COLS,
  PTY_ROWS,
  QUIET_WINDOW_MS,
  READY_TIMEOUT_MS,
} from "./constants.js"
import { resolveAuth, resolvePassword, type AuthInfo } from "./ssh-auth.js"
import { SessionHistory } from "./history.js"
import { cleanAnsi, collapseCarriage, genSentinel, stripEcho, stripPrompt } from "./utils.js"

const log = createLogger("opencode-ssh-tool", { enabled: true })

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
  /** 异步提交成功（命令后台执行中） */
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

/** 后台哨兵监听最长存活时间（防泄漏） */
const MAX_WATCH_LEN = 10 * 60_000

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
  private _runningSentinel = ""
  private _runningCommand = ""
  private _watchTimer: ReturnType<typeof setInterval> | null = null
  private _closed = false
  private readonly _history: SessionHistory

  constructor(
    private readonly sessionID: string,
    history: SessionHistory,
    private readonly name = "default",
  ) {
    this._history = history
  }

  /**
   * 建立 SSH 连接并打开 PTY shell
   * @param opts 连接参数；显式传 password 时优先用密码认证，否则回退 resolveAuth（私钥/agent/环境变量）
   * @returns 连接结果
   */
  async connect(opts: { host: string; user: string; port?: number; password?: string }): Promise<ConnectResult> {
    const port = opts.port ?? 22
    // 显式密码（支持 file: 路径读取）> resolveAuth（私钥/agent/环境变量密码）
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

      client.once("error", (err: Error) => fail(err.message))

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
              const text = chunk.toString()
              this._appendBuffer(text)
            })
            stream.on("close", () => {
              this._connected = false
              this._remoteBusy = false
            })
            stream.on("error", (e: Error) => {
              log.error("PTY stream 错误", e)
              this._connected = false
            })

            // 等待登录 banner / 初始提示符输出稳定后清空 buffer（不算业务输出）
            ;(async () => {
              await new Promise((r) => setTimeout(r, 400))
              this._buffer = ""
              this._runningStartPos = null
              this._runningSentinel = ""
              log.info(`连接成功 ${opts.user}@${opts.host}:${port} (session ${this.sessionID})`)
              resolve({ ok: true, host: opts.host, user: opts.user, port })
            })()
          },
        )
      })

      client.connect(config)
    })
  }

  /**
   * 异步提交命令：立即返回，命令后台执行，输出由后台监听收集进 history
   * @param command 命令
   * @returns 提交结果（立即返回，不等待命令完成）
   */
  async submit(command: string): Promise<ExecResult> {
    const startTs = Date.now()
    if (!this._connected || !this._stream) {
      return { ok: false, output: "", error: "Not connected" }
    }
    if (this._remoteBusy) {
      return { ok: false, output: "", error: "Previous command still running, poll with ssh_status first" }
    }

    const sentinel = genSentinel()
    const combo = `${command}; echo ${sentinel}`
    const startPos = this._buffer.length
    this._runningStartPos = startPos
    this._runningSentinel = sentinel
    this._runningCommand = command
    this._remoteBusy = true
    this._lastActive = startTs
    this._stream.write(combo + "\r")
    this._startBackgroundWatch(sentinel, startPos, command)

    return {
      ok: true,
      output: "",
      submitted: true,
      host: this._host,
      command,
      duration: 0,
    }
  }

  /**
   * 在当前会话执行命令（哨兵法，同步等待），保留 cwd/环境
   * @param command 命令
   * @param timeout 超时毫秒，默认 30s
   * @returns 执行结果
   */
  async exec(command: string, timeout: number = EXEC_TIMEOUT_MS): Promise<ExecResult> {
    const startTs = Date.now()
    if (!this._connected || !this._stream) {
      return { ok: false, output: "", error: "Not connected" }
    }
    if (this._remoteBusy) {
      return { ok: false, output: "", error: "Previous command still running, poll with ssh_status first" }
    }

    const sentinel = genSentinel()
    const combo = `${command}; echo ${sentinel}`
    const startPos = this._buffer.length
    this._remoteBusy = true
    this._lastActive = startTs
    this._stream.write(combo + "\r")

    const outcome = await this._waitSentinel(sentinel, startPos, timeout, startTs)

    switch (outcome.kind) {
      case "done": {
        this._remoteBusy = false
        const out = cleanAnsi(stripEcho(collapseCarriage(this._buffer.slice(startPos, outcome.idx)), combo))
        this._buffer = this._buffer.slice(outcome.afterNewline)
        this._history.append(command, out)
        return {
          ok: true,
          output: this._truncate(out),
          host: this._host,
          command,
          duration: Date.now() - startTs,
        }
      }
      case "interactive": {
        this._remoteBusy = false
        const out = cleanAnsi(collapseCarriage(this._buffer.slice(startPos)))
        this._history.append(command, out)
        return {
          ok: true,
          output: this._truncate(out),
          interactive: true,
          host: this._host,
          command,
          duration: Date.now() - startTs,
        }
      }
      case "running":
      case "timeout": {
        this._runningStartPos = startPos
        this._runningSentinel = sentinel
        this._runningCommand = command
        this._remoteBusy = true
        this._startBackgroundWatch(sentinel, startPos, command)
        const out = cleanAnsi(stripEcho(collapseCarriage(this._buffer.slice(startPos)), combo))
        this._history.append(command, out)
        return {
          ok: true,
          output: this._truncate(out),
          running: outcome.kind === "running",
          timeout: outcome.kind === "timeout",
          host: this._host,
          command,
          duration: Date.now() - startTs,
        }
      }
    }
  }

  /**
   * 读取并清空未消费缓冲（交互/轮询场景）
   * @returns 未消费输出
   */
  async readBuffer(): Promise<{ ok: boolean; output: string; error?: string }> {
    if (!this._connected) {
      return { ok: false, output: "", error: "Not connected" }
    }
    let out: string

    if (this._runningStartPos !== null) {
      // 有后台运行上下文：输出从运行起点取到哨兵为止
      const idx = this._findSentinel(this._runningSentinel, this._runningStartPos)
      if (idx >= 0) {
        out = this._buffer.slice(this._runningStartPos, idx)
        this._buffer = this._buffer.slice(idx)
        this._clearRunningContext()
      } else {
        out = this._buffer.slice(this._runningStartPos)
      }
    } else {
      out = this._buffer
      this._buffer = ""
    }

    return { ok: true, output: this._truncate(stripPrompt(cleanAnsi(collapseCarriage(out)))) }
  }

  /**
   * 获取会话状态（供 ssh_status）
   * @returns 状态对象
   */
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

  /**
   * 获取会话消息对记录（供 ssh_terminal / HTTP 页面渲染）
   * @returns 消息对存储
   */
  getHistory(): SessionHistory {
    return this._history
  }

  /**
   * 获取当前运行中命令的实时缓冲（合并覆盖后，不消费 buffer）
   * @returns 运行中命令的当前进度文本；无运行命令则返回空串
   */
  getRunningOutput(): string {
    if (this._runningStartPos === null || !this._connected || !this._runningCommand) return ""
    const combo = `${this._runningCommand}; echo ${this._runningSentinel}`
    const raw = this._buffer.slice(this._runningStartPos)
    return cleanAnsi(stripEcho(collapseCarriage(raw), combo)).trim()
  }

  /**
   * 关闭连接，清理会话态（幂等）
   */
  close(): void {
    if (this._closed) return
    this._closed = true
    if (this._watchTimer) clearInterval(this._watchTimer)
    if (this._stream) {
      try {
        this._stream.end()
      } catch {
        /* 忽略 */
      }
    }
    if (this._client) {
      try {
        this._client.end()
      } catch {
        /* 忽略 */
      }
    }
    this._connected = false
    this._remoteBusy = false
    this._history.dispose()
    log.hook("ssh_disconnect", `关闭会话 ${this._host}`)
  }

  /**
   * 追加输出到未消费 buffer，超限时截断头部（保留尾部）并修正运行索引
   * @param text 新增输出文本
   */
  private _appendBuffer(text: string): void {
    this._buffer += text
    if (this._buffer.length > MAX_BUFFER_LEN) {
      const trimmed = this._buffer.length - MAX_BUFFER_LEN
      this._buffer = this._buffer.slice(trimmed)
      // 同步修正后台运行上下文索引（若存在）
      if (this._runningStartPos !== null) {
        this._runningStartPos = Math.max(0, this._runningStartPos - trimmed)
      }
      log.info(`buffer 超限截断 ${trimmed} 字符，当前 ${this._buffer.length}`)
    }
  }

  private _waitSentinel(
    sentinel: string,
    startPos: number,
    timeout: number,
    startTs: number,
  ): Promise<{ kind: "done" | "interactive" | "running" | "timeout"; idx?: number; afterNewline?: number }> {
    return new Promise((resolve) => {
      let lastLen = this._buffer.length
      let lastChange = Date.now()

      const timer = setInterval(() => {
        const idx = this._findSentinel(sentinel, startPos)
        if (idx >= 0) {
          clearInterval(timer)
          const nl = this._buffer.indexOf("\n", idx)
          resolve({
            kind: "done",
            idx,
            afterNewline: nl >= 0 ? nl + 1 : idx + sentinel.length,
          })
          return
        }

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

        // 动画检测：持续有新输出且已超过动画阈值 → 判定仍在运行
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

  /** 后台哨兵监听：轮询到哨兵 → 收集输出进 history + busy=false，供 ssh_status/ssh_terminal 读取 */
  private _startBackgroundWatch(sentinel: string, startPos: number, command: string): void {
    if (this._watchTimer) clearInterval(this._watchTimer)
    const born = Date.now()
    this._watchTimer = setInterval(() => {
      if (!this._connected || Date.now() - born > MAX_WATCH_LEN) {
        this._remoteBusy = false
        this._clearRunningContext()
        if (this._watchTimer) clearInterval(this._watchTimer)
        return
      }
      const idx = this._findSentinel(sentinel, startPos)
      if (idx >= 0) {
        // 命令完成：收集输出（哨兵前内容，剔除回显）进 history
        const combo = `${command}; echo ${sentinel}`
        const out = cleanAnsi(stripEcho(collapseCarriage(this._buffer.slice(startPos, idx)), combo))
        this._history.append(command, out)
        const nl = this._buffer.indexOf("\n", idx)
        this._buffer = this._buffer.slice(nl >= 0 ? nl + 1 : idx + sentinel.length)
        this._remoteBusy = false
        this._clearRunningContext()
        if (this._watchTimer) clearInterval(this._watchTimer)
      }
    }, 200)
  }

  /** 在缓冲中定位哨兵行起始位置（哨兵串开头，容忍行前 ANSI bracketed-paste 序列） */
  private _findSentinel(sentinel: string, fromPos: number): number {
    const esc = sentinel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    // 行开始(\r|\n|串首) + 可选 ANSI 序列(如 ESC[?2004l) + 哨兵串
    const re = new RegExp(`(?:^|[\\r\\n])(?:\\x1b\\[[0-9;?]*[a-zA-Z])*${esc}`, "g")
    re.lastIndex = fromPos
    const m = re.exec(this._buffer)
    if (!m) return -1
    // m[0] = 行开始 + ANSI + sentinel，哨兵串开头 = m.index + m[0].length - sentinel.length
    return m.index + m[0].length - sentinel.length
  }

  /** 清理后台运行上下文 */
  private _clearRunningContext(): void {
    this._runningStartPos = null
    this._runningSentinel = ""
    this._runningCommand = ""
  }

  /** 输出截断保护 */
  private _truncate(s: string): string {
    if (s.length <= MAX_OUTPUT_LEN) return s
    return `${s.slice(0, MAX_OUTPUT_LEN)}\n... [output truncated, ${s.length} chars total]`
  }
}
