// 全局常量：权限正则、超时、PTY 尺寸、输出限制、语言配置

/** 只读命令白名单（整串匹配，含元字符的命令不适用白名单） */
export const ALLOW_READONLY =
  /^(?:ls|cd|cat|grep|tail|head|ps|df|free|pwd|env|echo|curl|wget|git status|whoami|hostname|date|uname|uptime)\b.*$/

/** 高危命令黑名单（命中直接拒绝，不进 ask） */
export const DENY =
  /(?:rm\s+(?:-[a-z]*[fr][a-z]*(?:\s+-[a-z]*[fr][a-z]*)?\s+)?(?:\/(?:\s|$)|~|\.(?:\.)?|\/(?:etc|var|usr|boot|bin|sbin|lib|lib64|opt|root)(?:\s|$))|shutdown|reboot|halt|poweroff|mkfs|mkswap|fdisk|parted|dd\s+(?:if|of|bs|count|conv)\s*=|iptables|ufw|firewall-cmd|systemctl|service\s+\w+\s+(?:stop|restart|kill)|kill(?:all)?\s|pkill\s|passwd\s|useradd|userdel|groupadd|groupdel|chown\s+-R|chmod\s+-R\s+777\s+\/|apt\s+remove|apt-get\s+remove|npm\s+(?:uninstall|rm)\b|DROP\s+TABLE|TRUNCATE\s+TABLE|DROP\s+DATABASE|:\(\)\s*\{|>\s*\/etc\/(?:passwd|shadow|sudoers|fstab)|curl\s+.*\|\s*(?:ba)?sh|wget\s+.*\|\s*(?:ba)?sh|base64\s+-d\s*[|>])/

/** shell 元字符（出现即降级走 ask，防白名单拼接绕过） */
export const SHELL_META = /[;|&`$()<>]/

/**
 * 交互模式判定阈值（毫秒）：命令提交时终端仍 busy，距上次提交不足此时长视为连续快速命令（排队等待执行），
 * 超过此时长仍 busy 视为用户正在给运行中的交互程序输入（sudo 密码/REPL 等），按交互输入原样 send。
 */
export const INTERACTIVE_BUSY_MS = 500

/** 动画检测阈值：连续输出超过此时长仍无哨兵/静默 → 判定仍在运行 */
export const ANIMATION_WINDOW_MS = 5_000

/**
 * 语法/解析错误收尾的安静窗口（毫秒）：识别到 shell 语法错误后，先等输出停止增长此时长再收尾，
 * 确保 pwsh 异步/批量渲染的多行错误块被完整收进输出窗口。
 */
export const SYNTAX_QUIET_MS = 300

/**
 * 语法/解析错误收尾的等待上限（毫秒）：自首次识别起最长等此时长，防止错误块持续刷新时迟迟不收尾。
 */
export const SYNTAX_MAX_WAIT_MS = 1_000

/**
 * 中断探针补发间隔默认值（秒）：用户显式 Ctrl+C 后**立即**补发首条探针，
 * 之后每隔此间隔补发一次，直到命令结束（收到当前 seq 标记）。
 * 实际间隔取配置 interruptProbeInterval（秒），非法/缺失时回退此默认值。
 * 仅用于周期性重发探针，**绝不**用于"到点判命令完成"——完成判定只认当前 seq 的完成标记。
 */
export const INTERRUPT_PROBE_INTERVAL_DEFAULT_SEC = 5

/** ssh2 认证超时（毫秒） */
export const READY_TIMEOUT_MS = 10_000

/**
 * SSH 协议级保活间隔（毫秒）：向服务端发送 keepalive 全局请求的周期（对应 OpenSSH 的 ServerAliveInterval）。
 * 空闲时防止路径上的 NAT/防火墙/远端 sshd 因空闲超时掐断长驻连接。
 * 该请求是**连接层带外**消息（`keepalive@openssh.com` 全局请求），不写入任何 channel/PTY，
 * 因此不会污染终端输出、也不干扰完成标记机制。
 */
export const SSH_KEEPALIVE_INTERVAL_MS = 20_000

/**
 * SSH 保活最大连续未响应次数（对应 OpenSSH 的 ServerAliveCountMax）：
 * 连续这么多次 keepalive 未收到响应即判定连接死亡并断开（触发既有 error/close 处理标离线）。
 */
export const SSH_KEEPALIVE_COUNT_MAX = 3

// ===== WebSocket 应用层心跳（server ↔ agent / server ↔ browser 两条 WS 共用） =====

/**
 * WS 应用层心跳发送间隔（毫秒）：server 每隔此时长向每条连接下发 `{type:"ping"}`。
 * 心跳是**应用层消息**，只在 WS 通道上收发，绝不写入 PTY/终端，不污染终端输出与完成标记。
 */
export const HEARTBEAT_INTERVAL_MS = 25_000

/**
 * 心跳漏应答超时（毫秒）：server 发出 `{type:"ping"}` 后此时长内未收到 `{type:"pong"}`，
 * 即判定该连接为**半开**（socket 已死但进程不知）并 terminate；对端随即收到 close、
 * 走既有自动重连，从而把"半开"变成"可发现 + 可自愈"。
 */
export const HEARTBEAT_TIMEOUT_MS = 10_000

/**
 * 客户端（agent / 浏览器）心跳静默超时（毫秒）：超过此时长未收到 server 的 `{type:"ping"}`
 * 即判定服务端半开，客户端主动 close 并走既有重连。取 2 倍发送间隔，容忍单次丢包/调度抖动。
 */
export const HEARTBEAT_CLIENT_TIMEOUT_MS = HEARTBEAT_INTERVAL_MS * 2

/** 注入总超时（含重试）：超过此时长仍无首个标记则断连报错 */
export const INJECT_TIMEOUT_MS = 30_000

/** PTY 窗口尺寸（常规终端尺寸，避免 zsh 按超大缓冲重绘导致提示符/回显错位） */
export const PTY_ROWS = 40
export const PTY_COLS = 120

/** 屏幕模拟保留的 scrollback 行数（模型侧 toModelText 与浏览器侧 headless 渲染一致） */
export const TERM_SCROLLBACK_LINES = 2000

/** 单次工具返回输出上限（字节） */
export const MAX_OUTPUT_LEN = 50_000

/** 会话连续原始字节流上限（超过裁剪最旧部分） */
export const RAW_LOG_MAX = 1_048_576

/** 工具语言环境变量（工具描述/CLI/session 文案，en | zh，默认 en） */
export const LANG_ENV = "SSH_TOOL_LANG"

/** Web 界面语言环境变量（仅页面 UI 文案，en | zh，默认 en） */
export const WEB_LANG_ENV = "SSH_WEB_LANG"

/** 插件缓存根目录（历史消息对存文件，随会话清理） */
export const CACHE_DIR = ".opencode/plugins-cache/opencode-ssh-tool"

// ===== 终端注入协议标记 =====

/** 完成标记前缀（后续跟退出码 + ">"，如 <SSH_DONE:0>） */
export const DONE_TAG = "<SSH_DONE:"

/** shell 类型探测前缀：probeCommand 回显 <前缀>$0 */
export const SHELL_ID_PREFIX = "__SHELL_ID__"

/** 探测输出匹配正则 */
export const SHELL_ID_RE = /\b__SHELL_ID__\b/

/**
 * 独立 HTTP 服务协议/代码版本号：插件的 server/agent 协议或服务端逻辑变更时递增。
 * server-entry 启动时写入 server.json（proto 字段），ensureServer 发现既有服务版本不符时
 * 杀掉旧进程重启，防止 detached 持久进程一直跑旧代码导致行为不生效（如 busy 卡死）。
 */
export const SERVER_PROTO_VERSION = 17
