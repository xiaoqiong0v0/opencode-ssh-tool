// 多语言：工具描述与参数说明的 en/zh 字典，默认英文

import { LANG_ENV } from "./constants.js"

export type Lang = "en" | "zh"

/** 平铺文案键：值为 en/zh 字符串对的字典键（排除嵌套 args 对象） */
type FlatKey = { [K in keyof typeof T]: (typeof T)[K] extends Record<Lang, string> ? K : never }[keyof typeof T]

/**
 * 读取当前语言（环境变量 SSH_TOOL_LANG，默认 en）
 * @returns 语言标识
 */
export function getLang(): Lang {
  return process.env[LANG_ENV] === "zh" ? "zh" : "en"
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
  ssh_terminal: {
    en: "Open a scrollable viewer of the full terminal transcript/status of the current SSH session as an HTML attachment.",
    zh: "以 HTML 附件弹窗展示当前 SSH 会话的完整终端记录/状态，支持滚动查看。",
  },
  ssh_disconnect: {
    en: "Close the current SSH connection and clean up session state.",
    zh: "关闭当前 SSH 连接并清理会话态。",
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
} as const

/** 取某语言下的一条文案 */
export function tr(key: FlatKey, lang: Lang): string {
  return T[key][lang]
}