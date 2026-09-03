// 多语言：工具描述与参数说明的 en/zh 字典，默认英文

import { LANG_ENV } from "./constants.js"

export type Lang = "en" | "zh"

/** 平铺文案键：值为 en/zh 字符串对的字典键（排除嵌套 args 对象） */
export type FlatKey = { [K in keyof typeof T]: (typeof T)[K] extends Record<Lang, string> ? K : never }[keyof typeof T]

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
  submitted: {
    en: "Command submitted (async). Running in background: check term_cli status for completion, then term_cli read to read output.",
    zh: "命令已异步提交，后台执行中：用 term_cli status 查完成状态，再用 term_cli read 读取输出。",
  },
  send_ok: {
    en: "Sent: {text}",
    zh: "已发送：{text}",
  },
  local_connect_ok: {
    en: "Started: {cmd} (terminal {name})",
    zh: "已启动：{cmd}（终端 {name}）",
  },
  local_connect_title_fail: {
    en: "Local terminal start failed",
    zh: "本地终端启动失败",
  },
  term_cli: {
    en: "Unified terminal CLI: SSH (remote) / local shell (wsl, pwsh, bash) / container (docker exec) sessions. For ANY terminal you already have or can start locally — WSL, Docker containers, or local shells — use the 'local' subcommand INSTEAD of running commands via bash. Subcommands: connect / local / exec / read / send / status / disconnect / help. Use 'help' for full usage.",
    zh: "统一终端命令行工具：SSH（远程）/ 本地 shell（wsl、pwsh、bash）/ 容器（docker exec）会话。对任何本地可启动的终端——WSL、Docker 容器或本地 shell——应使用 'local' 子命令，而不是用 bash 直接执行。子命令: connect / local / exec / read / send / status / disconnect / help。用 'help' 查看完整用法。",
  },
  term_cli_args: {
    en: "Full command line string, e.g. 'local \"wsl bash\"' / 'exec \"ls -la\" -w' / 'connect user@host'; defaults to 'help' when empty.",
    zh: "完整命令行字符串，如 'local \"wsl bash\"' / 'exec \"ls -la\" -w' / 'connect user@host'；空时默认 'help'。",
  },
  term_cli_help: {
    en: `term_cli unified CLI tool: manage SSH / local (wsl, pwsh, bash) / container (docker exec) terminal sessions.
Use 'local' for any terminal started on this machine (WSL, Docker containers, local shells).

Usage: term_cli <subcommand> [args]

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
  term_cli connect root@192.168.1.10
  term_cli connect user@host -p file:C:\\secrets\\pw.txt
  term_cli local "docker exec -it myctr bash" -n db
  term_cli exec "ls -la" -w
  term_cli exec "cd /var/log && tail -50 syslog"
  term_cli send "mypass\\r" -n default
  term_cli read -n db -s buffer
  term_cli status
  term_cli disconnect -n db
`,
    zh: `term_cli 统一命令行工具：管理 SSH / 本地（wsl、pwsh、bash）/ 容器（docker exec）终端会话。
本机可启动的终端（WSL、Docker 容器、本地 shell）一律用 'local' 子命令。

用法: term_cli <子命令> [参数]

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
  term_cli connect root@192.168.1.10
  term_cli connect user@host -p file:C:\\secrets\\pw.txt
  term_cli local "docker exec -it myctr bash" -n db
  term_cli exec "ls -la" -w
  term_cli exec "cd /var/log && tail -50 syslog"
  term_cli send "mypass\\r" -n default
  term_cli read -n db -s buffer
  term_cli status
  term_cli disconnect -n db
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
    en: "No active terminal. Use term_cli connect (SSH) or term_cli local (wsl/docker/local shell) first.",
    zh: "无活动终端。请先用 term_cli connect（SSH）或 term_cli local（wsl/docker/本地 shell）建立。",
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
  exec_failed: {
    en: "Execution failed",
    zh: "执行失败",
  },
  session_disconnected: {
    en: "SSH session disconnected",
    zh: "SSH 会话已断开",
  },
  status_busy_hint: {
    en: "\nHint: a command is still running. Wait and retry, or call term_cli read for partial output.",
    zh: "\n提示：仍有命令在执行，请等待后重试或调用 term_cli read 获取部分输出。",
  },
  status_idle_hint: {
    en: "\nHint: no command running. You can safely execute a new command or call term_cli read for remaining output.",
    zh: "\n提示：无命令在执行，可安全执行新命令或调用 term_cli read 读取剩余输出。",
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
  web_title: { en: "Terminal Records", zh: "终端记录" },
  web_loading: { en: "Loading...", zh: "加载中..." },
  web_load_failed: { en: "Failed to load records", zh: "记录加载失败" },
  web_session_gone: { en: "Session not found or disconnected", zh: "会话不存在或已断开" },
  web_time: { en: "Time", zh: "时间" },
  web_terminals: { en: "terminals", zh: "终端" },
  web_local: { en: "local", zh: "本地" },
  web_commands: { en: "commands", zh: "条命令" },
  web_auto_refresh: { en: "auto-refresh every 2s", zh: "每 2s 自动刷新" },
  web_no_session: { en: "No session. Use term_cli connect first.", zh: "无会话，请先用 term_cli connect 建立连接。" },
  web_running: { en: "[running] ", zh: "[运行中] " },
  web_new_messages: { en: "↓ New messages", zh: "↓ 新消息" },
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
} as const

/** 取某语言下的一条文案 */
export function tr(key: FlatKey, lang: Lang): string {
  return T[key][lang]
}
