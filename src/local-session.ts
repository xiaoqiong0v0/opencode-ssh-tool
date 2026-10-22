// LocalSession：基于 Bun.Terminal 的本地/容器 PTY 会话（本地 shell、docker exec -it 等）
// 连接建立与传输层实现；命令执行/后台监听/标记检测继承自 BaseSession

import { INJECT_TIMEOUT_MS, PTY_COLS, PTY_ROWS } from "./constants.js"
import { tr } from "./i18n.js"
import type { ExecResult } from "./base-session.js"
import { BaseSession } from "./base-session.js"
import log from "./log.js"
import { delimiter, join } from "node:path"
import { statSync } from "node:fs"

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

/**
 * 在 PATH 中查找指定可执行文件，跳过 WindowsApps 下的 Store 执行别名
 *（Bun.spawn 在 service/ConPTY 上下文拉不起该重解析点）。
 * @param names 候选文件名（按优先级）
 * @returns 第一个真实可执行文件路径；找不到返回 null
 */
function findRealOnPath(names: string[]): string | null {
  // Windows 环境变量实际键名通常是 `Path`；Bun 的 process.env 可能不像 Node 那样大小写不敏感
  const pathEnv = process.env.PATH || process.env.Path || process.env.path || ""
  const dirs = pathEnv.split(delimiter)
  for (const dir of dirs) {
    for (const name of names) {
      const p = join(dir, name)
      try {
        if (!statSync(p).isFile()) continue
        if (/[\\/]WindowsApps[\\/]/i.test(p)) continue // Store 别名：跳过
        return p
      } catch {
        /* 不存在/不可访问 */
      }
    }
  }
  return null
}

/**
 * Windows 下规范化 PowerShell 启动命令：
 * - 优先找**真实** `pwsh.exe`（跳过 WindowsApps 别名），使用其全路径；
 * - 找不到则回退 `powershell.exe`（5.1），并记一行日志；
 * - 两者都没有时退回 `pwsh.exe`，让上层给出可行动错误。
 * 已有 -NoLogo 不重复添加；非 win32 或非 pwsh 首参原样返回。
 * @param argv 拆分后的命令参数
 * @returns 规范化后的参数
 */
function normalizeLocalArgv(argv: string[]): string[] {
  if (process.platform !== "win32" || argv.length === 0) return argv
  const exe = argv[0].toLowerCase()
  if (exe !== "pwsh" && exe !== "pwsh.exe") return argv
  const rest = argv.slice(1)
  const addNoLogo = rest.some((a) => a.toLowerCase() === "-nologo") ? [] : ["-NoLogo"]
  const pwsh = findRealOnPath(["pwsh.exe"])
  if (pwsh) return [pwsh, ...addNoLogo, ...rest]
  const psOnPath = findRealOnPath(["powershell.exe"])
  // PATH 取不到时的绝对兜底（%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe）
  const sysRoot = process.env.SystemRoot || process.env.windir
  let ps = psOnPath
  if (!ps && sysRoot) {
    const psDefault = join(sysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    try {
      if (statSync(psDefault).isFile()) ps = psDefault
    } catch {
      /* 没有 5.1 */
    }
  }
  if (ps) {
    log.info("未找到可用的 PowerShell 7（pwsh 仅 Store 别名），回退到 powershell 5.1")
    return [ps, ...addNoLogo, ...rest]
  }
  return ["pwsh.exe", ...addNoLogo, ...rest]
}

export class LocalSession extends BaseSession {
  private _term: Bun.Terminal | null = null
  private _proc: Bun.Subprocess | null = null
  private _program = ""

  /** 本地 PTY 提交分隔符：Windows ConPTY 用 \r；Unix PTY 用 \n（不依赖 ICRNL 转换） */
  protected override _lineSep = process.platform === "win32" ? "\r" : "\n"

  protected get _extraResult(): Partial<ExecResult> { return {} }

  /** 本地会话：发送前语法预检可接 */
  get isLocal(): boolean { return true }

  protected _ready(): boolean {
    return this._connected && this._term !== null && this._adapter !== null
  }

  protected _write(data: string): void {
    this._term!.write(data)
  }

  protected _closeTransport(): void {
    try { this._term?.close() } catch { /* ignore */ }
    try { this._proc?.kill() } catch { /* ignore */ }
    log.hook("local_disconnect", `关闭本地终端 ${this._program} (session ${this.sessionID}, term ${this.name})`)
  }

  /**
   * 启动本地/容器 PTY 终端，探测 shell 类型后注入完成标记脚本
   * @param opts 命令（如 "pwsh" / "docker exec -it <容器> bash"）与工作目录
   * @returns 是否启动成功
   */
  async connect(opts: { command: string; cwd?: string }): Promise<{ ok: boolean; error?: string }> {
    try {
      // 内联 terminal 选项：让 Bun 走 terminal_info 路径、向子进程传 pty_slave_fd，
      // 子进程才能 setsid+TIOCSCTTY 取得自己的控制终端。若改为传入已 new 出的 Terminal 对象，
      // Bun 不传该 fd，子进程会沿用 opencode TUI 的 pts，导致 sudo 等读 /dev/tty 的程序抢占 TUI 屏幕/键盘。
      const proc = Bun.spawn(normalizeLocalArgv(splitCommand(opts.command)), {
        cwd: opts.cwd,
        terminal: {
          cols: PTY_COLS,
          rows: PTY_ROWS,
          name: "xterm-256color",
          data: (_t, d) => this._appendBuffer(new TextDecoder().decode(d)),
          exit: (_t, exitCode, signal) => {
            this._connected = false
            this._setBusy(false, "本地 PTY 退出")
            log.warn(`本地终端 PTY 退出 ${opts.command} (session ${this.sessionID}, term ${this.name}, exit=${exitCode}, signal=${signal})`)
          },
        },
      })
      // 监听子进程退出：docker exec/wsl 前端进程退出时此回调触发，用于定位"无 close() 日志却掉线"的场景
      const bootAt = Date.now()
      proc.exited.then((code) => {
        log.error(`本地终端子进程退出 ${opts.command} (session ${this.sessionID}, term ${this.name}, code=${code}, boot2exit=${Date.now() - bootAt}ms)`)
      }).catch(() => { /* ignore */ })
      // 内联路径下终端句柄由子进程持有（Bun 拥有该终端，子进程退出时自动 close），故从 proc.terminal 取
      this._term = proc.terminal ?? null
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
        log.error(`Shell 探测超时，连接终止 (session ${this.sessionID}, term ${this.name})`)
        this.close()
        return { ok: false, error: tr("shell_probe_timeout", this._lang) }
      }
      this._adapter = adapter
      log.info(`Shell 探测结果: ${this._adapter.name} (session ${this.sessionID}, term ${this.name})`)

      this._buffer = ""
      this._cursor = 0
      // 初始化完成：发基线标记（seq=0），让首条命令也有"前驱"可裁剪，免疫控制台屏幕重放
      this._sendBaselineMarker()
      return { ok: true }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log.error(`本地终端启动失败 ${opts.command} (session ${this.sessionID}, term ${this.name})`, msg)
      this.close()
      // 把底层 EPIPE/ENOENT 转成可行动提示（原始错误附后，便于排障）
      let friendly = msg
      if (/EPIPE|broken pipe/i.test(msg)) friendly = `${tr("local_start_epipe", this._lang)}: ${msg}`
      else if (/ENOENT|Executable not found|not found in \$PATH/i.test(msg)) {
        friendly = `${tr("local_start_not_found", this._lang).replace("{cmd}", opts.command)}: ${msg}`
      }
      return { ok: false, error: friendly }
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