// SshSession：ssh2 长驻连接 + PTY shell 管理，
// 完成标记法：注入 PROMPT_COMMAND 脚本，命令完成时输出 <SSH_DONE:退出码>

import { Client, type ConnectConfig } from "ssh2"
import log, { isDebugEnabled, ssh2Trace } from "./log.js"
import {
  INJECT_TIMEOUT_MS,
  PTY_COLS,
  PTY_ROWS,
  READY_TIMEOUT_MS,
  SSH_KEEPALIVE_COUNT_MAX,
  SSH_KEEPALIVE_INTERVAL_MS,
} from "./constants.js"
import { tr } from "./i18n.js"
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
    log.hook("ssh_disconnect", `关闭会话 ${this._host} (session ${this.sessionID}, term ${this.name})`)
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
      // 协议级保活（连接层带外，`keepalive@openssh.com` 全局请求，不写入 channel/PTY）：
      // 空闲时定期发 keepalive，避免被路径上的 NAT/防火墙/远端 sshd 的空闲超时掐断长驻连接；
      // 连续 SSH_KEEPALIVE_COUNT_MAX 次无响应则由 ssh2 判定连接死亡（error.level="client-timeout"）。
      keepaliveInterval: SSH_KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: SSH_KEEPALIVE_COUNT_MAX,
      // ssh2 协议 trace 属 debug 级；仅在真正会输出时才注册回调，避免关闭时 ssh2 每次仍做无谓的消息拼装。
      // ssh2Trace 内部再丢弃随输出量增长的 CHANNEL_DATA 等行，只记有界的握手/认证事件。
      ...(isDebugEnabled() ? { debug: (msg: string) => ssh2Trace(this._logTag, msg) } : {}),
      ...auth,
    }

    const client = new Client()
    let settled = false

    return new Promise<ConnectResult>((resolve) => {
      const fail = (msg: string) => {
        if (settled) return
        settled = true
        log.error(`连接失败 ${opts.host} (session ${this.sessionID}, term ${this.name})`, msg)
        resolve({ ok: false, host: opts.host, user: opts.user, port, error: msg })
      }

      // 常驻错误监听：ssh2 可能多次发 error（断线/通道异常），once 首次触发后失效会变 unhandled
      client.on("error", (err: Error) => {
        if (!settled) {
          fail(err.message)
          return
        }
        // 保活判死（ssh2 在连续 keepalive 无响应后置 level="client-timeout"）与普通断线的日志可区分
        const level = (err as Error & { level?: string }).level
        if (level === "client-timeout") {
          log.error(`SSH 保活超时，连接判定死亡 ${opts.host} (session ${this.sessionID}, term ${this.name})`, err)
        } else {
          log.error(`SSH 会话错误 ${opts.host} (session ${this.sessionID}, term ${this.name})`, err)
        }
        this._connected = false
        this._setBusy(false, "SSH 会话错误")
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
            stream.on("close", () => { this._connected = false; this._setBusy(false, "PTY stream 关闭") })
            stream.on("error", (e: Error) => { log.error(`PTY stream 错误 (session ${this.sessionID}, term ${this.name})`, e); this._connected = false })

            ;(async () => {
              await new Promise((r) => setTimeout(r, 400))
              this._buffer = ""
              this._cursor = 0
              this._runningStartPos = null
              log.info(`连接成功 ${opts.user}@${opts.host}:${port} (session ${this.sessionID}, term ${this.name})`)

              if (this._history.totalPairs() > 0) this._history.clear()

              const deadline = Date.now() + INJECT_TIMEOUT_MS
              const adapter = await this._probeShell(deadline)
              if (!adapter) {
                log.error(`Shell 探测超时，终止连接 ${opts.user}@${opts.host} (session ${this.sessionID}, term ${this.name})`)
                this.close()
                resolve({ ok: false, host: opts.user, user: opts.user, port, error: tr("shell_probe_timeout", this._lang) })
                return
              }
              this._adapter = adapter
              log.info(`Shell 探测结果: ${this._adapter.name} (session ${this.sessionID}, term ${this.name})`)

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