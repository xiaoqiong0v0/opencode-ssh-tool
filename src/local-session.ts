// LocalSession：基于 Bun.Terminal 的本地/容器 PTY 会话（本地 shell、docker exec -it 等）
// 连接建立与传输层实现；命令执行/后台监听/标记检测继承自 BaseSession

import { INJECT_TIMEOUT_MS, PTY_COLS, PTY_ROWS } from "./constants.js"
import type { ExecResult } from "./base-session.js"
import { BaseSession } from "./base-session.js"
import log from "./log.js"

export interface LocalStatus {
  connected: boolean
  busy: boolean
  pending: number
  name?: string
  program?: string
  lastActive?: number
  connectedAt?: number
}

/** 命令行字符串拆分为参数数组（Bun.spawn 要求数组形式；支持双/单引号分组） */
function splitCommand(cmd: string): string[] {
  const args: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(cmd))) args.push(m[1] ?? m[2] ?? m[3])
  return args
}

export class LocalSession extends BaseSession {
  private _term: Bun.Terminal | null = null
  private _proc: Bun.Subprocess | null = null
  private _program = ""

  protected _statusCmd = "local_status"

  protected get _extraResult(): Partial<ExecResult> { return {} }

  protected _ready(): boolean {
    return this._connected && this._term !== null && this._adapter !== null
  }

  protected _write(data: string): void {
    this._term!.write(data)
  }

  protected _closeTransport(): void {
    try { this._term?.close() } catch { /* ignore */ }
    try { this._proc?.kill() } catch { /* ignore */ }
    log.hook("local_disconnect", `关闭本地终端 ${this._program}`)
  }

  /**
   * 启动本地/容器 PTY 终端，探测 shell 类型后注入完成标记脚本
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
        exit: () => { this._connected = false; this._remoteBusy = false },
      })
      const proc = Bun.spawn(splitCommand(opts.command), { terminal: term, cwd: opts.cwd })
      this._term = term
      this._proc = proc
      this._program = opts.command
      this._connected = true
      this._connectedAt = Date.now()
      this._lastActive = Date.now()
      await new Promise((r) => setTimeout(r, 400))
      this._buffer = ""
      this._cursor = 0
      this._runningStartPos = null
      log.info(`本地终端启动 ${opts.command} (session ${this.sessionID}, term ${this.name})`)

      if (this._history.totalPairs() > 0) this._history.clear()

      const deadline = Date.now() + INJECT_TIMEOUT_MS
      const adapter = await this._probeShell(deadline)
      if (!adapter) {
        log.error("Shell 探测超时，连接终止")
        this.close()
        return { ok: false, error: "Shell 探测超时（30s 内 shell 未就绪），连接终止" }
      }
      this._adapter = adapter
      log.info(`Shell 探测结果: ${this._adapter.name}`)

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
}