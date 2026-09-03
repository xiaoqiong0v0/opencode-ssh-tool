// 多语言：工具描述与参数说明的 en/zh 字典，默认英文

import { LANG_ENV } from "./constants.js"

export type Lang = "en" | "zh"

/** 平铺文案键：值为 en/zh 字符串对的字典键（排除嵌套 args 对象） */
type FlatKey = { [K in keyof typeof T]: (typeof T)[K] extends Record<Lang, string> ? K : never }[keyof typeof T]

/**
 * 读取当前语言：环境变量 SSH_TOOL_LANG 优先，否则用配置语言（默认 en）
 * @param configured 配置文件 toolLang 值
 * @returns 语言标识
 */
export function getLang(configured: Lang = "en"): Lang {
  const env = process.env[LANG_ENV]
  if (env === "zh") return "zh"
  if (env === "en") return "en"
  return configured
}

/** 工具描述与参数说明字典 */
export const T = {
  ssh_connect: {
    en: "Open a long-lived SSH connection with a PTY shell in the current session. Reconnecting the same session closes the previous connection first. Returns a connection id.",
    zh: "在当前会话建立长驻 SSH 连接并打开 PTY shell；同一会话重复连接会先关闭旧连接。返回连接标识。",
  },
  ssh_connect_args: {
    host: { en: "Target host or IP", zh: "目标主机 host / IP" },
    user: { en: "Login username", zh: "登录用户名" },
    port: { en: "Port, default 22", zh: "端口，默认 22" },
    name: {
      en: "Terminal name within the session, default 'default'. Creating with an existing name closes the old one first. Use distinct names to keep multiple terminals.",
      zh: "会话内的终端名，默认 'default'。同名创建会先关闭旧终端。用不同名称可保持多个终端。",
    },
    password: {
      en: "Password for password auth (optional). Supports plain text or 'file:<abs path>' to read from a file (avoids exposing it in context). If omitted, falls back to SSH key / agent / SSH_PASSWORD env.",
      zh: "密码认证密码（可选）。支持明文或 'file:<绝对路径>' 从文件读取（避免暴露在上下文中）。省略时回退到 SSH 私钥 / agent / 环境变量 SSH_PASSWORD。",
    },
  },
  term_exec: {
    en: "Execute a command in an SSH, local or container terminal (by terminal name), preserving cwd and environment. Commands outside the read-only allowlist require user approval.",
    zh: "在 SSH / 本地 / 容器终端（按终端名）执行命令，保留 cwd 与环境变量；白名单外的命令需用户审批。",
  },
  term_exec_args: {
    command: { en: "Shell command to execute", zh: "要执行的 shell 命令" },
    waitResult: {
      en: "Wait for the command to finish and return its output. Default false: submit async, return immediately; read results later via term_read.",
      zh: "是否等待命令完成并返回其输出。默认 false：异步提交，立即返回；稍后通过 term_read 读取结果。",
    },
    name: {
      en: "Target terminal name, default 'default'. Must match a name from ssh_connect.",
      zh: "目标终端名，默认 'default'。需与 ssh_connect 创建的名称一致。",
    },
  },
  submitted: {
    en: "Command submitted (async). Running in background: check term_status for completion, then term_read to read output.",
    zh: "命令已异步提交，后台执行中：用 term_status 查完成状态，再用 term_read 读取输出。",
  },
  term_read: {
    en: "Read output of an SSH, local or container terminal: buffered (unconsumed, for interactive/polling) or history (completed command+output pairs, first N or last N). Returns browser URL for the full scrollable viewer when the HTTP server is on.",
    zh: "读取 SSH / 本地 / 容器终端输出：缓冲（未消费，交互/轮询用）或历史（已完成的命令+输出对，前 N 条或后 N 条）。HTTP 服务开启时返回浏览器查看完整记录的地址。",
  },
  term_send: {
    en: "Send text or keystrokes to an SSH, local or container terminal for interactive prompts (sudo password, confirmations, interrupts). Escapes: \\r or \\n = Enter, \\x03 = Ctrl-C, \\x04 = Ctrl-D, \\x1a = Ctrl-Z, \\x1b = Esc. After sending, read the result with term_read.",
    zh: "向 SSH / 本地 / 容器终端发送文本或按键，用于交互提示（sudo 密码、确认、中断等）。转义：\\r 或 \\n = 回车，\\x03 = Ctrl-C，\\x04 = Ctrl-D，\\x1a = Ctrl-Z，\\x1b = Esc。发送后用 term_read 读取结果。",
  },
  term_send_args: {
    text: {
      en: "Text or key sequence to send. Use \\r or \\n for Enter, \\x03 for Ctrl-C, \\x1b for Esc. For sudo password prompts send the password followed by \\r.",
      zh: "要发送的文本或按键序列。回车用 \\r 或 \\n，Ctrl-C 用 \\x03，Esc 用 \\x1b。sudo 密码提示时发送密码后跟 \\r。",
    },
    name: {
      en: "Target terminal name, default 'default'.",
      zh: "目标终端名，默认 'default'。",
    },
  },
  send_ok: {
    en: "Sent: {text}",
    zh: "已发送：{text}",
  },
  send_title: {
    en: "SSH send",
    zh: "SSH 发送",
  },
  term_read_args: {
    source: {
      en: "Where to read from: 'buffer' (unconsumed live output) or 'history' (completed pairs, default).",
      zh: "读取来源：'buffer'（实时未消费输出）或 'history'（已完成消息对，默认）。",
    },
    lines: { en: "Max lines to read from buffer, all if omitted", zh: "读取缓冲行数上限，默认全部" },
    direction: {
      en: "Which end to take (history): 'tail' (last N, default) or 'head' (first N). At most N pairs.",
      zh: "取哪一端（history）：'tail'（最后 N 条，默认）或 'head'（前 N 条）。最多 N 条。",
    },
    limit: {
      en: "Number of pairs to return (history, default 10). Capped at total pairs.",
      zh: "返回的对数（history，默认 10）。不超过总对数。",
    },
    includeCommand: {
      en: "Whether to include the command line in history output. Default false (output only).",
      zh: "是否在 history 结果中包含命令行。默认 false（只返回输出）。",
    },
    name: {
      en: "Target terminal name, default 'default'.",
      zh: "目标终端名，默认 'default'。",
    },
  },
  term_status: {
    en: "Check SSH/local/container terminal state (busy, pending, connection) by terminal name (all terminals if omitted) and the HTTP server state (URL/port/session count). Use busy to poll completion instead of reading animated output.",
    zh: "按终端名检查 SSH / 本地 / 容器终端状态（busy、未消费量、连接；省略则列出全部终端）及 HTTP 服务状态（URL/端口/会话数）。用 busy 轮询完成情况，避免读取动画中间态。",
  },
  term_status_args: {
    name: {
      en: "Terminal name to check; omit to list all terminals.",
      zh: "要检查的终端名；省略则列出全部终端。",
    },
  },
  term_disconnect: {
    en: "Close the terminal of a name (default 'default') for an SSH, local or container session, or all terminals when name is omitted, and clean up session state.",
    zh: "关闭指定名称（默认 'default'）的 SSH / 本地 / 容器终端，name 省略则关闭全部终端，并清理会话态。",
  },
  term_disconnect_args: {
    name: {
      en: "Terminal name to disconnect; omit to disconnect all terminals.",
      zh: "要断开的终端名；省略则断开全部终端。",
    },
  },
  local_connect: {
    en: "Start a local/container PTY terminal (e.g. pwsh, bash, docker exec -it <container> sh) in the current session. Same-session reconnect closes the previous one. Uses Bun.Terminal (runs in the opencode Bun runtime).",
    zh: "在当前会话启动本地/容器 PTY 终端（如 pwsh、bash、docker exec -it <容器> sh）；同一会话重复启动会先关闭旧的。基于 Bun.Terminal（opencode Bun 运行时内运行）。",
  },
  local_connect_args: {
    command: {
      en: "Command to launch, e.g. pwsh / bash / docker exec -it <container> sh",
      zh: "要启动的命令，如 pwsh / bash / docker exec -it <容器> sh",
    },
    name: {
      en: "Terminal name within the session, default 'default'. Creating with an existing name closes the old one first.",
      zh: "会话内的终端名，默认 'default'。同名创建会先关闭旧终端。",
    },
    cwd: {
      en: "Working directory, defaults to plugin cwd.",
      zh: "工作目录，默认插件所在目录。",
    },
  },
  local_connect_title_ok: {
    en: "Local terminal started",
    zh: "本地终端已启动",
  },
  local_connect_ok: {
    en: "Started: {cmd} (terminal {name})",
    zh: "已启动：{cmd}（终端 {name}）",
  },
  local_connect_title_fail: {
    en: "Local terminal start failed",
    zh: "本地终端启动失败",
  },
  ssh_cli: {
    en: "Unified CLI tool (CLI style): SSH / local / container terminal sessions. Subcommands: connect / local / exec / read / send / status / disconnect / help. Use 'help' for full usage.",
    zh: "统一命令行工具（CLI 风格）：SSH/本地/容器终端会话。子命令: connect / local / exec / read / send / status / disconnect / help。用 'help' 查看完整用法。",
  },
  ssh_cli_args: {
    en: "Full command line string, e.g. 'exec \"ls -la\" -w' or 'connect user@host'; defaults to 'help' when empty.",
    zh: "完整命令行字符串，如 'exec \"ls -la\" -w' 或 'connect user@host'；空时默认 'help'。",
  },
  ssh_cli_help: {
    en: `ssh_cli unified CLI tool: manage SSH / local / container terminal sessions.

Usage: ssh_cli <subcommand> [args]

Subcommands:
  connect <target> [-u user] [-n name] [-p password|file:path]
      target = user@host[:port] (e.g. root@server.local:22); open a long-lived SSH session
      -p accepts plain text or file:<path> (read password from file, avoids exposure)
  local "<command>" [-n name] [-c cwd]
      start a local/container terminal (e.g. "pwsh" / "docker exec -it <container> sh")
  exec "<command>" [-n name] [-w]
      run a command in the terminal (default: submit async and return immediately; -w waits for result)
  read [-n name] [-s buffer|history] [-l limit] [--head] [--include-command]
      read terminal output: buffer (live) / history (default tail last N)
  send "<text>" [-n name]
      send text/keystrokes (\\r Enter, \\x03 Ctrl-C, \\x04 Ctrl-D, \\x1a Ctrl-Z, \\x1b Esc)
  status [-n name]
      terminal state (busy/pending/connection); omit name to list all
  disconnect [-n name]
      close terminal; omit name to close all
  help
      show this help

Examples:
  ssh_cli connect root@192.168.1.10
  ssh_cli connect user@host -p file:C:\\secrets\\pw.txt
  ssh_cli local "docker exec -it myctr bash" -n db
  ssh_cli exec "ls -la" -w
  ssh_cli exec "cd /var/log && tail -50 syslog"
  ssh_cli send "mypass\\r" -n default
  ssh_cli read -n db -s buffer
  ssh_cli status
  ssh_cli disconnect -n db
`,
    zh: `ssh_cli 统一命令行工具：管理 SSH / 本地 / 容器终端会话。

用法: ssh_cli <子命令> [参数]

子命令:
  connect <target> [-u user] [-n name] [-p password|file:path]
      target = user@host[:port]（如 root@server.local:22）；建立 SSH 长驻会话
      -p 支持明文或 file:<路径>（从文件读密码，避免暴露）
  local "<command>" [-n name] [-c cwd]
      启动本地/容器终端（如 "pwsh" / "docker exec -it <容器> sh"）
  exec "<command>" [-n name] [-w]
      在指定终端执行命令（默认异步提交立即返回；-w 同步等待结果）
  read [-n name] [-s buffer|history] [-l limit] [--head] [--include-command]
      读终端输出：buffer 实时 / history 历史（默认 tail 后 N 条）
  send "<text>" [-n name]
      发送文本/按键（\\r 回车、\\x03 Ctrl-C、\\x04 Ctrl-D、\\x1a Ctrl-Z、\\x1b Esc）
  status [-n name]
      终端状态（busy/pending/连接）；省略 name 列出全部
  disconnect [-n name]
      断开终端；省略 name 断开全部
  help
      显示本帮助

示例:
  ssh_cli connect root@192.168.1.10
  ssh_cli connect user@host -p file:C:\\secrets\\pw.txt
  ssh_cli local "docker exec -it myctr bash" -n db
  ssh_cli exec "ls -la" -w
  ssh_cli exec "cd /var/log && tail -50 syslog"
  ssh_cli send "mypass\\r" -n default
  ssh_cli read -n db -s buffer
  ssh_cli status
  ssh_cli disconnect -n db
`,
  },
  denied: {
    en: "Denied by user.",
    zh: "用户已拒绝。",
  },
  cli_bad_target: {
    en: "Bad target: \"{target}\"",
    zh: "目标格式错误: \"{target}\"",
  },
  cli_connect_usage: {
    en: "Usage: connect user@host[:port] [-u user] [-n name] [-p password]",
    zh: "用法: connect user@host[:port] [-u user] [-n name] [-p password]",
  },
  cli_need_user_host: {
    en: "Need user and host",
    zh: "需要 user 和 host",
  },
  cli_local_usage: {
    en: "Usage: local \"<command>\" [-n name] [-c cwd]",
    zh: "用法: local \"<command>\" [-n name] [-c cwd]",
  },
  cli_exec_usage: {
    en: "Usage: exec \"<command>\" [-n name] [-w]",
    zh: "用法: exec \"<command>\" [-n name] [-w]",
  },
  cli_send_usage: {
    en: "Usage: send \"<text>\" [-n name]",
    zh: "用法: send \"<text>\" [-n name]",
  },
  cli_need_command: {
    en: "Need a command",
    zh: "需要命令",
  },
  cli_need_text: {
    en: "Need text to send",
    zh: "需要发送内容",
  },
  cli_unknown: {
    en: "Unknown command: {cmd}",
    zh: "未知命令: {cmd}",
  },
  st_name: { en: "name", zh: "名称" },
  st_type: { en: "type", zh: "类型" },
  st_connected: { en: "connected", zh: "已连接" },
  st_busy: { en: "busy", zh: "忙碌" },
  st_pending: { en: "pending", zh: "待消费" },
  st_bytes: { en: "bytes", zh: "字节" },
  st_host: { en: "host", zh: "主机" },
  st_program: { en: "program", zh: "程序" },
  st_last_active: { en: "lastActive", zh: "最后活动" },
  st_connected_at: { en: "connectedAt", zh: "连接时间" },
  st_http_server: { en: "httpServer", zh: "HTTP 服务" },
  st_active_sessions: { en: "activeSessions", zh: "活跃会话" },
  st_disabled: { en: "disabled", zh: "已禁用" },
  denied_danger: {
    en: "Dangerous command, execution rejected.",
    zh: "危险命令，已拒绝执行。",
  },
  not_connected: {
    en: "No SSH session. Please run ssh_connect first.",
    zh: "未建立 SSH 会话，请先调用 ssh_connect。",
  },
  rejected_connect: {
    en: "Connection rejected.",
    zh: "连接已被拒绝。",
  },
  invalid_name: {
    en: "Invalid terminal name. Use letters, digits, underscore, hyphen or dot (max 64 chars), no path separators.",
    zh: "终端名非法。仅允许字母、数字、下划线、中划线、点（最多 64 字符），不得含路径分隔符。",
  },
  no_sessions: {
    en: "No active SSH sessions.",
    zh: "当前没有活动的 SSH 会话。",
  },
  connect_title_ok: {
    en: "SSH connected",
    zh: "SSH 已连接",
  },
  connect_ok: {
    en: "Connected: {user}@{host}:{port} (session {sid}, terminal {name})",
    zh: "连接成功：{user}@{host}:{port}（session {sid}，终端 {name}）",
  },
  connect_title_fail: {
    en: "SSH connection failed",
    zh: "SSH 连接失败",
  },
  unknown_error: {
    en: "Unknown error",
    zh: "未知错误",
  },
  exec_title: {
    en: "SSH exec: {cmd}",
    zh: "SSH 执行: {cmd}",
  },
  exec_failed: {
    en: "Execution failed",
    zh: "执行失败",
  },
  session_output_title: {
    en: "SSH session output",
    zh: "SSH 会话输出",
  },
  session_disconnected: {
    en: "SSH session disconnected",
    zh: "SSH 会话已断开",
  },
  status_busy_hint: {
    en: "\nHint: a command is still running. Wait and retry, or call term_read for partial output.",
    zh: "\n提示：仍有命令在执行，请等待后重试或调用 term_read 获取部分输出。",
  },
  status_idle_hint: {
    en: "\nHint: no command running. You can safely execute a new command or call term_read for remaining output.",
    zh: "\n提示：无命令在执行，可安全执行新命令或调用 term_read 读取剩余输出。",
  },
  status_title: {
    en: "SSH session status",
    zh: "SSH 会话状态",
  },
  server_title: {
    en: "SSH HTTP server",
    zh: "SSH HTTP 服务",
  },
  server_info: {
    en: "HTTP server enabled\nurl: {url}\nport: {port}\nactive sessions: {n}\nOpen {url} in a browser to view terminal records (scrollable, auto-refreshing).",
    zh: "HTTP 服务已启用\nurl: {url}\nport: {port}\n活跃会话: {n}\n浏览器访问 {url} 查看终端记录（可滚动、自动刷新）。",
  },
  browser_full_record: {
    en: "\nBrowser full record: {url}",
    zh: "\n浏览器查看完整记录：{url}",
  },
  server_not_enabled: {
    en: "\n(HTTP server not enabled)",
    zh: "\n（HTTP 服务未启用）",
  },
  history_title: {
    en: "SSH history (last {n} / total {total})",
    zh: "SSH 历史（最后 {n} 条 / 共 {total} 条）",
  },
  history_title_head: {
    en: "SSH history (first {n} / total {total})",
    zh: "SSH 历史（前 {n} 条 / 共 {total} 条）",
  },
  disconnected_ok: {
    en: "SSH connection closed ({host}).",
    zh: "SSH 连接已断开（{host}）。",
  },
  disconnected_all_ok: {
    en: "All SSH terminals closed (last host {host}).",
    zh: "已断开全部 SSH 终端（最后主机 {host}）。",
  },
  err_not_connected: {
    en: "Not connected",
    zh: "未连接",
  },
  err_busy: {
    en: "Previous command still running, poll with term_status first",
    zh: "上一条命令仍在执行，请先 term_status 轮询",
  },
  err_shell_open: {
    en: "Shell open failed",
    zh: "shell 打开失败",
  },
  err_no_such_session: {
    en: "Session not found or disconnected",
    zh: "会话不存在或已断开",
  },
  truncated: {
    en: "... [output truncated, {n} chars total]",
    zh: "... [输出已截断，共 {n} 字符]",
  },
} as const

/** 取某语言下的一条文案 */
export function tr(key: FlatKey, lang: Lang): string {
  return T[key][lang]
}
