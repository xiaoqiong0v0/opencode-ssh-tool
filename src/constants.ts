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

/** PTY 窗口尺寸（大窗口减少分页） */
export const PTY_ROWS = 200
export const PTY_COLS = 500

/** 单次工具返回输出上限（字节） */
export const MAX_OUTPUT_LEN = 50_000

/** 工具描述语言环境变量（en | zh，默认 en） */
export const LANG_ENV = "SSH_TOOL_LANG"

/** 插件缓存根目录（历史消息对存文件，随会话清理） */
export const CACHE_DIR = ".opencode/plugins-cache/opencode-ssh-tool"
