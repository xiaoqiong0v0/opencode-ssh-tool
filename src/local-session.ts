// LocalSession：基于 Bun.Terminal 的本地/容器 PTY 会话（本地 shell、docker exec -it 等），
// 哨兵法执行逻辑与 SshSession 一致（复用 utils 工具函数），支持交互（sudo 密码/确认/中断）

import createLogger from "@xiaoqiong0v0/opencode-plugin-logger"
import {
  ANIMATION_WINDOW_MS,
  EXEC_TIMEOUT_MS,
  MAX_OUTPUT_LEN,
  PTY_COLS,
  PTY_ROWS,
  QUIET_WINDOW_MS,
} from "./constants.js"
import { SessionHistory } from "./history.js"
import { cleanAnsi, collapseCarriage, genSentinel, stripEcho, stripPrompt } from "./utils.js"

const log = createLogger("opencode-ssh-tool")

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

/** 后台哨兵监听最长存活时间（防泄漏） */
const MAX_WATCH_LEN = 10 * 60_000

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
   * 启动本地/容器 PTY 终端（复用哨兵法执行架构）
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
      this._runningStartPos = null
      this._runningSentinel = ""
      log.info(`本地终端启动 ${opts.command} (session ${this.sessionID}, term ${this.name})`)
      return { ok: true }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log.error(`本地终端启动失败 ${opts.command}`, msg)
      this.close()
      return { ok: false, error: msg }
    }
  }

  /**
   * 异步提交命令：立即返回，命令后台执行，输出由后台监听收集进 history
   * @param command 命令
   * @returns 提交结果（立即返回，不等待命令完成）
   */
  async submit(command: string): Promise<LocalExecResult> {
    const startTs = Date.now()
    if (!this._connected || !this._term) return { ok: false, output: "", error: "Not connected" }
    if (this._remoteBusy) return { ok: false, output: "", error: "Previous command still running, poll with local_status first" }

    const sentinel = genSentinel()
    const combo = `${command}; echo ${sentinel}`
    const startPos = this._buffer.length
    this._runningStartPos = startPos
    this._runningSentinel = sentinel
    this._runningCommand = command
    this._remoteBusy = true
    this._lastActive = startTs
    this._term.write(combo + "\r")
    this._startBackgroundWatch(sentinel, startPos, command)

    return { ok: true, output: "", submitted: true, command, duration: 0 }
  }

  /**
   * 在当前终端执行命令（哨兵法，同步等待），保留 cwd/环境
   * @param command 命令
   * @param timeout 超时毫秒，默认 30s
   * @returns 执行结果
   */
  async exec(command: string, timeout: number = EXEC_TIMEOUT_MS): Promise<LocalExecResult> {
    const startTs = Date.now()
    if (!this._connected || !this._term) return { ok: false, output: "", error: "Not connected" }
    if (this._remoteBusy) return { ok: false, output: "", error: "Previous command still running, poll with local_status first" }

    const sentinel = genSentinel()
    const combo = `${command}; echo ${sentinel}`
    const startPos = this._buffer.length
    this._remoteBusy = true
    this._lastActive = startTs
    this._term.write(combo + "\r")

    const outcome = await this._waitSentinel(sentinel, startPos, timeout, startTs)

    switch (outcome.kind) {
      case "done": {
        this._remoteBusy = false
        const out = stripEcho(collapseCarriage(this._buffer.slice(startPos, outcome.idx)), combo)
        this._buffer = this._buffer.slice(outcome.afterNewline)
        this._history.append(command, out)
        return { ok: true, output: this._truncate(cleanAnsi(out)), command, duration: Date.now() - startTs }
      }
      case "interactive": {
        this._remoteBusy = false
        const out = collapseCarriage(this._buffer.slice(startPos))
        this._history.append(command, out)
        return { ok: true, output: this._truncate(cleanAnsi(out)), interactive: true, command, duration: Date.now() - startTs }
      }
      case "running":
      case "timeout": {
        this._runningStartPos = startPos
        this._runningSentinel = sentinel
        this._runningCommand = command
        this._remoteBusy = true
        this._startBackgroundWatch(sentinel, startPos, command)
        const out = stripEcho(collapseCarriage(this._buffer.slice(startPos)), combo)
        this._history.append(command, out)
        return {
          ok: true,
          output: this._truncate(cleanAnsi(out)),
          running: outcome.kind === "running",
          timeout: outcome.kind === "timeout",
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
    if (!this._connected) return { ok: false, output: "", error: "Not connected" }
    let out: string
    if (this._runningStartPos !== null) {
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

  /**
   * 获取消息对记录（供渲染/落盘）
   * @returns 消息对存储
   */
  getHistory(): SessionHistory {
    return this._history
  }

  /**
   * 获取当前运行中命令的实时缓冲（合并覆盖后，不消费 buffer，保留 ANSI）
   * @returns 运行中命令的当前进度文本；无运行命令则返回空串
   */
  getRunningOutput(): string {
    if (this._runningStartPos === null || !this._connected || !this._runningCommand) return ""
    const combo = `${this._runningCommand}; echo ${this._runningSentinel}`
    const raw = this._buffer.slice(this._runningStartPos)
    return stripEcho(collapseCarriage(raw), combo).trim()
  }

  /**
   * 关闭终端，清理会话态（幂等）
   */
  close(): void {
    if (this._closed) return
    this._closed = true
    if (this._watchTimer) clearInterval(this._watchTimer)
    try {
      this._term?.close()
    } catch {
      /* 忽略 */
    }
    try {
      this._proc?.kill()
    } catch {
      /* 忽略 */
    }
    this._connected = false
    this._remoteBusy = false
    this._history.dispose()
    log.hook("local_disconnect", `关闭本地终端 ${this._program}`)
  }

  /** 追加输出到未消费 buffer，超限时截断头部（保留尾部）并修正运行索引 */
  private _appendBuffer(text: string): void {
    this._buffer += text
    if (this._buffer.length > MAX_BUFFER_LEN) {
      const trimmed = this._buffer.length - MAX_BUFFER_LEN
      this._buffer = this._buffer.slice(trimmed)
      if (this._runningStartPos !== null) {
        this._runningStartPos = Math.max(0, this._runningStartPos - trimmed)
      }
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
          resolve({ kind: "done", idx, afterNewline: nl >= 0 ? nl + 1 : idx + sentinel.length })
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

  /** 后台哨兵监听：轮询到哨兵 → 收集输出进 history + busy=false */
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
        const combo = `${command}; echo ${sentinel}`
        const out = stripEcho(collapseCarriage(this._buffer.slice(startPos, idx)), combo)
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
    const re = new RegExp(`(?:^|[\\r\\n])(?:\\x1b\\[[0-9;?]*[a-zA-Z])*${esc}`, "g")
    re.lastIndex = fromPos
    const m = re.exec(this._buffer)
    if (!m) return -1
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
