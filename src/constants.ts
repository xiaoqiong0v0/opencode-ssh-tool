// 全局常量：权限正则、超时、PTY 尺寸、输出限制、语言配置

/** 只读命令白名单（整串匹配，含元字符的命令不适用白名单） */
export const ALLOW_READONLY =
  /^(?:ls|cd|cat|grep|tail|head|ps|df|free|pwd|env|echo|curl|wget|git status|whoami|hostname|date|uname|uptime)\b.*$/

/** 高危命令黑名单（命中直接拒绝，不进 ask） */
export const DENY =
  /(?:rm\s+-rf|shutdown|reboot|mkfs|dd\s|DROP\s+TABLE|TRUNCATE\s+TABLE|:\(\)\s*\{|>\s*\/etc\/passwd)/

/** shell 元字符（出现即降级走 ask，防白名单拼接绕过） */
export const SHELL_META = /[;|&`$()<>]/

/** 单次 ssh_exec 默认超时（毫秒） */
export const EXEC_TIMEOUT_MS = 30_000

/** 静默窗口阈值：输出停止增长超过此时长视为命令完成 */
export const QUIET_WINDOW_MS = 500

/** 动画检测阈值：连续输出超过此时长仍无哨兵/静默 → 判定仍在运行 */
export const ANIMATION_WINDOW_MS = 5_000

/** 会话空闲回收超时（毫秒） */
export const IDLE_TIMEOUT_MS = 10 * 60_000

/** 空闲清扫间隔（毫秒） */
export const SWEEP_INTERVAL_MS = 60_000

/** ssh2 认证超时（毫秒） */
export const READY_TIMEOUT_MS = 10_000

/** PTY 窗口尺寸（大窗口减少分页） */
export const PTY_ROWS = 200
export const PTY_COLS = 500

/** 单次工具返回输出上限（字节） */
export const MAX_OUTPUT_LEN = 50_000

/** 工具描述语言环境变量（en | zh，默认 en） */
export const LANG_ENV = "SSH_TOOL_LANG"
