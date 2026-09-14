// 全局常量：权限正则、超时、PTY 尺寸、输出限制、语言配置

/** 只读命令白名单（整串匹配，含元字符的命令不适用白名单） */
export const ALLOW_READONLY =
  /^(?:ls|cd|cat|grep|tail|head|ps|df|free|pwd|env|echo|curl|wget|git status|whoami|hostname|date|uname|uptime)\b.*$/

/** 高危命令黑名单（命中直接拒绝，不进 ask） */
export const DENY =
  /(?:rm\s+(?:-[a-z]*[fr][a-z]*(?:\s+-[a-z]*[fr][a-z]*)?\s+)?(?:\/(?:\s|$)|~|\.(?:\.)?|\/(?:etc|var|usr|boot|bin|sbin|lib|lib64|opt|root)(?:\s|$))|shutdown|reboot|halt|poweroff|mkfs|mkswap|fdisk|parted|dd\s+(?:if|of|bs|count|conv)\s*=|iptables|ufw|firewall-cmd|systemctl|service\s+\w+\s+(?:stop|restart|kill)|kill(?:all)?\s|pkill\s|passwd\s|useradd|userdel|groupadd|groupdel|chown\s+-R|chmod\s+-R\s+777\s+\/|apt\s+remove|apt-get\s+remove|npm\s+(?:uninstall|rm)\b|DROP\s+TABLE|TRUNCATE\s+TABLE|DROP\s+DATABASE|:\(\)\s*\{|>\s*\/etc\/(?:passwd|shadow|sudoers|fstab)|curl\s+.*\|\s*(?:ba)?sh|wget\s+.*\|\s*(?:ba)?sh|base64\s+-d\s*[|>])/

/** shell 元字符（出现即降级走 ask，防白名单拼接绕过） */
export const SHELL_META = /[;|&`$()<>]/

/** 单次 ssh_exec 默认超时（毫秒） */
export const EXEC_TIMEOUT_MS = 30_000

/** 静默窗口阈值：输出停止增长超过此时长视为命令完成 */
export const QUIET_WINDOW_MS = 500

/** 动画检测阈值：连续输出超过此时长仍无哨兵/静默 → 判定仍在运行 */
export const ANIMATION_WINDOW_MS = 5_000

/** ssh2 认证超时（毫秒） */
export const READY_TIMEOUT_MS = 10_000

/** 注入生效等待超时：shell 执行注入命令并重绘提示符（输出首个标记）的最长等待 */
export const SETTLE_TIMEOUT_MS = 3_000

/** 注入总超时（含重试）：超过此时长仍无首个标记则断连报错 */
export const INJECT_TIMEOUT_MS = 30_000

/** PTY 窗口尺寸（常规终端尺寸，避免 zsh 按超大缓冲重绘导致提示符/回显错位） */
export const PTY_ROWS = 40
export const PTY_COLS = 120

/** 单次工具返回输出上限（字节） */
export const MAX_OUTPUT_LEN = 50_000

/** 会话连续原始字节流上限（超过裁剪最旧部分） */
export const RAW_LOG_MAX = 1_048_576

/** 工具描述语言环境变量（en | zh，默认 en） */
export const LANG_ENV = "SSH_TOOL_LANG"

/** 插件缓存根目录（历史消息对存文件，随会话清理） */
export const CACHE_DIR = ".opencode/plugins-cache/opencode-ssh-tool"

// ===== 终端注入协议标记 =====

/** 完成标记前缀（后续跟退出码 + ">"，如 <SSH_DONE:0>） */
export const DONE_TAG = "<SSH_DONE:"

/** 完成标记完整正则（内部于 shell-adapter 私有，避免 lastIndex 全局状态污染） */

/** 完成标记字符串：给定退出码 */
export const doneTag = (ec: number | string): string => `<SSH_DONE:${ec}>`

/** 注入确认 token：shell 执行注入脚本末尾的 echo 输出，用于确认注入完成 */
export const INJECT_TOKEN = "__SSH_INJECT_DONE__"

/** shell 类型探测前缀：probeCommand 回显 <前缀>$0 */
export const SHELL_ID_PREFIX = "__SHELL_ID__"

/** 探测输出匹配正则 */
export const SHELL_ID_RE = /\b__SHELL_ID__\b/

/** bash/zsh 注入脚本内部变量名（bash 历史号守卫；zsh precmd） */
export const VAR_LAST_HIST = "__SSH_LAST_HIST"

/** pwsh 注入脚本内部变量名（pending 标记 / history id / 嵌套等级 / 原 ReadLine） */
export const VAR_PENDING = "__SSH_PENDING"
export const VAR_HID = "__SSH_HID"
export const VAR_NESTED = "__SSH_NESTED"
export const VAR_ORIG_RL = "__SSH_ORIG_RL"
