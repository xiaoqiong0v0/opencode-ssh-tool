// Bun.Terminal 最小类型声明（opencode 插件运行在 Bun 运行时内，本地/容器执行会话使用）

declare namespace Bun {
  /** PTY 终端（POSIX openpty / Windows ConPTY） */
  interface Terminal {
    /** 向终端写入数据 */
    write(data: string | ArrayBufferView): number
    /** 调整终端尺寸 */
    resize(cols: number, rows: number): void
    /** 切换原始模式（禁用行缓冲与回显） */
    setRawMode(enabled: boolean): void
    /** 关闭终端 */
    close(): void
    /** 是否已关闭 */
    readonly closed: boolean
  }

  /** 终端选项 */
  interface TerminalOptions {
    cols?: number
    rows?: number
    name?: string
    /** 收到输出数据回调 */
    data?: (terminal: Terminal, data: Uint8Array) => void
    /** 终端流关闭回调（exitCode 0=EOF，1=错误；signal 当前恒为 null，保留待用） */
    exit?: (terminal: Terminal, exitCode: number, signal: string | null) => void
    /** 可接受更多数据回调 */
    drain?: (terminal: Terminal) => void
  }

  /** spawn 选项 */
  interface SpawnOptions {
    /**
     * 终端：请用**内联 `TerminalOptions`**，句柄从 `proc.terminal` 取。
     * **不要**把已 `new` 的 `Terminal` 对象传入 spawn——Bun（≥1.3.14）对其不传 `pty_slave_fd`，
     * 子进程不会 `setsid+TIOCSCTTY`，控制终端仍是调用方 pts（`sudo` 等读 `/dev/tty` 会污染 TUI）。
     */
    terminal?: TerminalOptions | Terminal
    cwd?: string
    env?: Record<string, string>
  }

  /** 子进程句柄 */
  interface Subprocess {
    /** 终止进程 */
    kill(signal?: number | string): void
    /** 退出 Promise */
    readonly exited: Promise<number>
    readonly exitCode: number | null
    /** 以 terminal 选项 spawn 时附加的终端句柄；未附加时为 undefined（内联路径下由此取句柄） */
    readonly terminal?: Bun.Terminal
  }
}

declare const Bun: {
  /**
   * 创建 PTY 终端。
   * **警示**：不要把该构造出的对象传给 `spawn` 的 `terminal`（Bun ≥1.3.14 不传 `pty_slave_fd`
   * → 子进程无控制终端，`sudo` 读 `/dev/tty` 会抢占调用方 TUI）；spawn 应内联 `TerminalOptions`。
   */
  Terminal: new (options?: Bun.TerminalOptions) => Bun.Terminal
  /** 通过 shell 衍生命令，可附加 PTY 终端 */
  spawn: (command: string | string[], options?: Bun.SpawnOptions) => Bun.Subprocess
}
