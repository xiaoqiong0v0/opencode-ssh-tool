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
    /** 终端流关闭回调（exitCode 0=EOF，1=错误） */
    exit?: (terminal: Terminal, exitCode: number, signal: number) => void
    /** 可接受更多数据回调 */
    drain?: (terminal: Terminal) => void
  }

  /** spawn 选项 */
  interface SpawnOptions {
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
  }
}

declare const Bun: {
  /** 创建可复用 PTY 终端（也可内联传给 spawn 的 terminal 选项） */
  Terminal: new (options?: Bun.TerminalOptions) => Bun.Terminal
  /** 通过 shell 衍生命令，可附加 PTY 终端 */
  spawn: (command: string | string[], options?: Bun.SpawnOptions) => Bun.Subprocess
}
