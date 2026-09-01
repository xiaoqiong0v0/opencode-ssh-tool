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
  },
  ssh_exec: {
    en: "Execute a command in the current SSH session, preserving cwd and environment. Commands outside the read-only allowlist require user approval.",
    zh: "在当前 SSH 会话执行命令，保留 cwd 与环境变量；白名单外的命令需用户审批。",
  },
  ssh_exec_args: {
    command: { en: "Shell command to execute", zh: "要执行的 shell 命令" },
    waitResult: {
      en: "Wait for the command to finish and return its output. Default false: submit async, return immediately; read results later via ssh_status / ssh_terminal / ssh_read.",
      zh: "是否等待命令完成并返回其输出。默认 false：异步提交，立即返回；稍后通过 ssh_status / ssh_terminal / ssh_read 读取结果。",
    },
  },
  submitted: {
    en: "Command submitted (async). Running in background: check ssh_status for completion, then ssh_terminal / ssh_read to read output.",
    zh: "命令已异步提交，后台执行中：用 ssh_status 查完成状态，再用 ssh_terminal / ssh_read 读取输出。",
  },
  ssh_read: {
    en: "Read the unconsumed buffered output of the current SSH session (for interactive prompts and polling).",
    zh: "读取当前 SSH 会话缓冲区的未消费输出（用于交互提示与轮询场景）。",
  },
  ssh_read_args: {
    lines: { en: "Max lines to read, all if omitted", zh: "读取行数上限，默认全部" },
  },
  ssh_status: {
    en: "Check whether the current SSH session has a command still running (busy), how much output is pending, and connection health. Use this to poll instead of reading animated output.",
    zh: "检查当前 SSH 会话是否仍有命令在执行（busy）、未消费输出量及连接状态。用于轮询判断，避免读取动画中间态。",
  },
  ssh_server: {
    en: "Show the local HTTP server status: enabled/disabled, actual URL and port (auto-assigned when 0), and active session count. Use this to get the browser address for viewing terminal records.",
    zh: "查看本地 HTTP 服务状态：是否启用、实际 URL 与端口（0 时自动分配）、活跃会话数。用于获取浏览器查看终端记录的地址。",
  },
  ssh_terminal: {
    en: "Get recent command+output history pairs (first N or last N) of the current SSH session as text (output only by default), and/or get the browser URL for the scrollable auto-refreshing terminal viewer.",
    zh: "获取当前 SSH 会话的命令+输出历史对（前 N 条或后 N 条）为文本（默认只返回输出），并可返回浏览器可滚动查看终端记录的地址。",
  },
  ssh_terminal_args: {
    direction: {
      en: "Which end to take: 'tail' (last N, default) or 'head' (first N). At most N pairs, no more than total pairs.",
      zh: "取哪一端：'tail'（最后 N 条，默认）或 'head'（前 N 条）。最多 N 条，不超过总对数。",
    },
    limit: {
      en: "Number of pairs to return (default 10). Capped at total pairs.",
      zh: "返回的对数（默认 10）。不超过总对数。",
    },
    includeCommand: {
      en: "Whether to include the command line in the output. Default false (output only).",
      zh: "是否在结果中包含命令行。默认 false（只返回输出）。",
    },
  },
  ssh_disconnect: {
    en: "Close the current SSH connection and clean up session state.",
    zh: "关闭当前 SSH 连接并清理会话态。",
  },
  server_disabled: {
    en: "HTTP server is disabled in config (ssh-tool.jsonc).",
    zh: "HTTP 服务已在配置中关闭（ssh-tool.jsonc）。",
  },
  server_failed: {
    en: "Failed to start HTTP server:",
    zh: "HTTP 服务启动失败：",
  },
  denied: {
    en: "Denied by user.",
    zh: "用户已拒绝。",
  },
  denied_danger: {
    en: "Dangerous command, execution rejected.",
    zh: "危险命令，已拒绝执行。",
  },
  not_connected: {
    en: "No SSH session. Please run ssh_connect first.",
    zh: "未建立 SSH 会话，请先调用 ssh_connect。",
  },
  rejected_connect: {
    en: "Connection request denied by user.",
    zh: "连接请求已被用户拒绝。",
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
    en: "Connected: {user}@{host}:{port} (session {sid})",
    zh: "连接成功：{user}@{host}:{port}（session {sid}）",
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
    en: "\nHint: a command is still running. Wait and retry, or call ssh_read for partial output.",
    zh: "\n提示：仍有命令在执行，请等待后重试或调用 ssh_read 获取部分输出。",
  },
  status_idle_hint: {
    en: "\nHint: no command running. You can safely execute a new command or call ssh_read for remaining output.",
    zh: "\n提示：无命令在执行，可安全执行新命令或调用 ssh_read 读取剩余输出。",
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
  err_not_connected: {
    en: "Not connected",
    zh: "未连接",
  },
  err_busy: {
    en: "Previous command still running, poll with ssh_status first",
    zh: "上一条命令仍在执行，请先 ssh_status 轮询",
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