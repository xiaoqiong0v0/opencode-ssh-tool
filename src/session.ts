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
import { resolveAuth } from "./ssh-auth.js"
import { cleanAnsi, genSentinel, stripEcho } from "./utils.js"

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
  host?: string
  user?: string
  port?: number
  lastActive?: number
  connectedAt?: number
}

/** 交互触发词（sudo 密码 / 分页器 / 确认提示），含中英文 */
const INTERACTIVE_RE =
  /(\[sudo\] password for|password for \S+:|Password:|密码:|--More--|\(END\)|\[y\/N\]|\[Y\/n\]|yes\/no|是\/否)/i

/** transcript 最大长度（超长截断防内存膨胀） */
const MAX_TRANSCRIPT_LEN = 2 * 1024 * 1024

/** 后台哨兵监听最长存活时间（防泄漏） */
const MAX_WATCH_LEN = 10 * 60_000

export class SshSession {
  private _client: Client | null = null
  private _stream: import("ssh2").ClientChannel | null = null
  private _connected = false
  private _remoteBusy = false
  private _buffer = ""
  private _transcript = ""
  private _host = ""
  private _user = ""
  private _port = 22
  private _connectedAt = 0
  private _lastActive = 0
  private _runningStartPos: number | null = null
  private _runningSentinel = ""
  private _watchTimer: ReturnType<typeof setInterval> | null = null
  private _closed = false

  constructor(private readonly sessionID: string) {}

  /**
   * 建立 SSH 连接并打开 PTY shell
   * @param opts 连接参数
   * @returns 连接结果
   */
  async connect(opts: { host: string; user: string; port?: number }): Promise<ConnectResult> {
    const port = opts.port ?? 22
    const auth = resolveAuth(opts.host)
    const config: ConnectConfig = {
      host: opts.host,
      port,
      username: opts.user,
      readyTimeout: READY_TIMEOUT_MS,
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
              fail(err?.message ?? "shell 打开失败")
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
              this._buffer += text
              this._transcript = (this._transcript + text).slice(-MAX_TRANSCRIPT_LEN)
            })
            stream.on("close", () => {
              this._connected = false
              this._remoteBusy = false
            })
            stream.on("error", (e: Error) => {
              log.error("PTY stream 错误", e)
              this._connected = false
            })

            log.info(`连接成功 ${opts.user}@${opts.host}:${port} (session ${this.sessionID})`)
            resolve({ ok: true, host: opts.host, user: opts.user, port })
          },
        )
      })

      client.connect(config)
    })
  }

  /**
   * 在当前会话执行命令（哨兵法），保留 cwd/环境
   * @param command 命令
   * @param timeout 超时毫秒，默认 30s
   * @returns 执行结果
   */
  async exec(command: string, timeout: number = EXEC_TIMEOUT_MS): Promise<ExecResult> {
    const startTs = Date.now()
    if (!this._connected || !this._stream) {
      return { ok: false, output: "", error: "未连接" }
    }
    if (this._remoteBusy) {
      return { ok: false, output: "", error: "上一条命令仍在执行，请先 ssh_status 轮询" }
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
        const out = cleanAnsi(stripEcho(this._buffer.slice(startPos, outcome.idx), combo))
        this._buffer = this._buffer.slice(outcome.afterNewline)
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
        const out = cleanAnsi(this._buffer.slice(startPos))
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
        this._remoteBusy = true
        this._startBackgroundWatch(sentinel, startPos)
        const out = cleanAnsi(stripEcho(this._buffer.slice(startPos), combo))
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
      return { ok: false, output: "", error: "未连接" }
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

    return { ok: true, output: this._truncate(cleanAnsi(out)) }
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
      host: this._host,
      user: this._user,
      port: this._port,
      lastActive: this._lastActive,
      connectedAt: this._connectedAt,
    }
  }

  /**
   * 获取完整终端记录（供 ssh_terminal HTML 渲染）
   * @returns 终端记录文本
   */
  getTranscript(): string {
    return this._transcript
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
    log.hook("ssh_disconnect", `关闭会话 ${this._host}`)
  }

  /** 更新最后活动时间（供空闲清扫） */
  touch(): void {
    this._lastActive = Date.now()
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

  /** 后台哨兵监听：轮询到哨兵即翻转 busy=false，供 ssh_status 轮询判定 */
  private _startBackgroundWatch(sentinel: string, startPos: number): void {
    if (this._watchTimer) clearInterval(this._watchTimer)
    const born = Date.now()
    this._watchTimer = setInterval(() => {
      if (!this._connected || Date.now() - born > MAX_WATCH_LEN) {
        this._remoteBusy = false
        this._clearRunningContext()
        if (this._watchTimer) clearInterval(this._watchTimer)
        return
      }
      if (this._findSentinel(sentinel, startPos) >= 0) {
        this._remoteBusy = false
        this._clearRunningContext()
        if (this._watchTimer) clearInterval(this._watchTimer)
      }
    }, 200)
  }

  /** 在缓冲中定位哨兵行起始位置（跳过命令回显所在行内的哨兵） */
  private _findSentinel(sentinel: string, fromPos: number): number {
    const esc = sentinel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const re = new RegExp(`(?:^|\\r?\\n)${esc}`, "g")
    re.lastIndex = fromPos
    const m = re.exec(this._buffer)
    if (!m) return -1
    return m.index + m[0].length
  }

  /** 清理后台运行上下文 */
  private _clearRunningContext(): void {
    this._runningStartPos = null
    this._runningSentinel = ""
  }

  /** 输出截断保护 */
  private _truncate(s: string): string {
    if (s.length <= MAX_OUTPUT_LEN) return s
    return `${s.slice(0, MAX_OUTPUT_LEN)}\n... [输出已截断，共 ${s.length} 字符]`
  }
}
