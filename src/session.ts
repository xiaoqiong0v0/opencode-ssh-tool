// SshSession：ssh2 长驻连接 + PTY shell 管理，
// 完成标记法：注入 PROMPT_COMMAND 脚本，命令完成时输出 <SSH_DONE:退出码>

import { Client, type ConnectConfig } from "ssh2"
import log from "./log.js"
import { INJECT_TIMEOUT_MS, PTY_COLS, PTY_ROWS, READY_TIMEOUT_MS } from "./constants.js"
import { resolveAuth, resolvePassword, type AuthInfo } from "./ssh-auth.js"
import type { ExecResult } from "./base-session.js"
import { BaseSession } from "./base-session.js"

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

export interface ConnectResult {
  ok: boolean
  host?: string
  user?: string
  port?: number
  error?: string
}

export class SshSession extends BaseSession {
  private _client: Client | null = null
  private _stream: import("ssh2").ClientChannel | null = null
  private _host = ""
  private _user = ""
  private _port = 22

  protected _statusCmd = "ssh_status"

  protected get _extraResult(): Partial<ExecResult> { return { host: this._host } }

  protected _ready(): boolean {
    return this._connected && this._stream !== null && this._adapter !== null
  }

  protected _write(data: string): void {
    this._stream!.write(data)
  }

  protected _closeTransport(): void {
    if (this._stream) { try { this._stream.end() } catch { /* ignore */ } }
    if (this._client) { try { this._client.end() } catch { /* ignore */ } }
    log.hook("ssh_disconnect", `关闭会话 ${this._host}`)
  }

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

            stream.on("data", (chunk: Buffer) => { this._appendBuffer(chunk.toString()) })
            stream.on("close", () => { this._connected = false; this._remoteBusy = false })
            stream.on("error", (e: Error) => { log.error("PTY stream 错误", e); this._connected = false })

            ;(async () => {
              await new Promise((r) => setTimeout(r, 400))
              this._buffer = ""
              this._cursor = 0
              this._runningStartPos = null
              log.info(`连接成功 ${opts.user}@${opts.host}:${port} (session ${this.sessionID})`)

              if (this._history.totalPairs() > 0) this._history.clear()

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
}