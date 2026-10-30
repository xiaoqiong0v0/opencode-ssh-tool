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
 * 后台收尾兜底监听间隔（毫秒）：命令进入后台（submit / exec 超动画窗口）后的**稀疏兜底**周期。
 * 完成判定已改为**数据到达事件驱动**（`_appendBuffer` → `_checkCompletion`），此定时器不参与常规判定，
 * 仅覆盖两类"非数据事件"：① 断连（子类只置 `_connected=false`、不回调基类）；
 * ② 极端漏判保护（数据事件被异常吞掉）。空闲（无运行命令）时不挂任何定时器。
 */
export const FALLBACK_WATCH_INTERVAL_MS = 1_000

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
 * 远程发送前语法预检总超时（毫秒）：远程 bash/zsh 跑 `bash -n`/`zsh -n`，pwsh 启动解析侧车。
 * 正常 <100ms（pwsh 冷启动约 1s）；超过此时长即销毁预检 channel 并**放行**命令（fail-open），
 * 绝不阻塞主命令/PTY。pwsh 多候选（pwsh → powershell）共享该总预算。
 */
export const REMOTE_PRECHECK_TIMEOUT_MS = 5_000

/** 远程预检单流（stdout/stderr）收集上限（字符）：只用于判错与提取片段，避免异常输出撑爆内存 */
export const REMOTE_PRECHECK_OUTPUT_MAX = 16 * 1024

/**
 * 远程 pwsh 预检命令体长度上限（字符）：超长命令直接放行（fail-open）。
 * pwsh 侧车协议为“一行 base64 请求”，超长单行在部分远程链路/管道上可能被截断；
 * 预检只是拦截增强，不值得为此承担误判风险。
 */
export const REMOTE_PRECHECK_COMMAND_MAX = 32 * 1024

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

/**
 * agent 实时推流最小间隔（毫秒）：推流改为**数据到达事件驱动**，同一间隔内到达的多次数据
 * 合并为一帧（上限约 10Hz），避免高频输出时逐 chunk 打爆 WS；空闲无数据时不挂任何定时器。
 */
export const AGENT_PUSH_MIN_INTERVAL_MS = 100

// ===== 会话状态（sessions）推送节奏：事件驱动 + 低频兜底 =====

/**
 * 状态推送合并窗口（毫秒）：状态改为**事件驱动**（cmdStart/cmdDone/busy 翻转/连接变化/会话增删/客户端拉取）即时触发，
 * 多个事件在此窗口内合并为一次全量 build+广播，避免注册+cmdStart 之类的连发造成多次全量构建。
 */
export const STATUS_PUSH_DEBOUNCE_MS = 80

/**
 * 状态推送兜底周期（毫秒）：事件驱动已覆盖全部服务端内存态变化，此周期仅兜底**带外变化**
 * （其他进程写状态文件导致的新终端 / pending / 标题变化等，服务端无对应事件），故取低频（≥10s）。
 */
export const STATUS_PUSH_FALLBACK_MS = 15_000

/**
 * 孤儿状态文件清理的服务启动宽限（毫秒）：服务刚启动时给存量 agent 一个"重连并注册"的窗口，
 * 窗口内不按"未被认领"清理状态文件，避免把仍在运行、尚未重连的进程的文件误删。
 */
export const ORPHAN_STATE_GRACE_MS = 60_000

/**
 * 孤儿状态文件的最小陈旧阈值（毫秒）：状态文件 updatedAt 早于此值才允许按"未认领"清理，
 * 避免误删刚写入、agent 尚未完成注册的文件。
 */
export const ORPHAN_STATE_MIN_AGE_MS = 10_000

/**
 * 陈旧孤儿终端阈值（毫秒）：Web 页删除某终端时，若本实例 agent **未**认领它，
 * 则需其"最近活动"（状态文件 updatedAt 与 history 目录 mtime 取较大者）早于此值才允许删除。
 * 用途：把"他实例正在使用的活终端"（活动频繁、状态文件新）与"真正无人认领的孤儿"区分开，
 * 在放宽删除校验（让离线孤儿可被手动删除）的同时，绝不误删别的实例正在用的活终端。
 */
export const STALE_ORPHAN_MS = 10 * 60 * 1000

/** 注入总超时（含重试）：超过此时长仍无首个标记则断连报错 */
export const INJECT_TIMEOUT_MS = 30_000

/** PTY 窗口尺寸（常规终端尺寸，避免 zsh 按超大缓冲重绘导致提示符/回显错位） */
export const PTY_ROWS = 40
export const PTY_COLS = 120

/** 屏幕模拟保留的 scrollback 行数（模型侧 toModelText 与浏览器侧 headless 渲染一致） */
export const TERM_SCROLLBACK_LINES = 2000

/** 单次工具返回输出上限（字节） */
export const MAX_OUTPUT_LEN = 50_000

// ===== SFTP 文件传输（v1） =====

/** 单次传输入口文件大小上限（字节，256 MiB）：超过直接拒绝，避免误传大文件打爆内存/链路 */
export const MAX_TRANSFER_BYTES = 256 * 1024 * 1024

/**
 * 单次传输整体超时（毫秒，10 分钟）：SFTP API 本身不接受超时参数，由调用方包装；
 * 到点后中止 SFTP 通道（destroy）并报 timeout，不再主动发起新的 rename/commit
 * （已发出的 rename 仍可能被服务端执行）。
 */
export const TRANSFER_TIMEOUT_MS = 10 * 60 * 1000

/**
 * 传输失败后的临时文件清理等待上限（毫秒）：
 * 通道异常/超时后远端回调可能永不返回，清理必须有时限，不能把错误路径挂死。
 */
export const TRANSFER_CLEANUP_TIMEOUT_MS = 3_000

/**
 * 通道中止后等待传输 job 真正 settle 的兜底上限（毫秒）：
 * job 自身 deadline + 清理预算应有界；超过该上限仍未结束则强制结算队列，
 * 避免单次异常永久堵住同一会话的后续传输（此时通道已中止，job 无法再提交）。
 */
export const TRANSFER_JOB_SETTLE_TIMEOUT_MS = 4 * TRANSFER_CLEANUP_TIMEOUT_MS

/**
 * 覆盖提交回退（备份旧目标 → 新文件就位）所需的最小剩余时间（毫秒）：
 * 剩余不足时不再开始回退，避免"旧目标已移走、新目标未就位"恰好被超时打断。
 */
export const TRANSFER_COMMIT_MIN_REMAINING_MS = 2_000

// ===== SFTP 传输任务事件（agent → server → Web）=====

/** 已结束（done/failed）任务在 server 内存中的保留时长（毫秒），过期移除 */
export const TRANSFER_TASK_TTL_MS = 10 * 60 * 1000

/** 传输进度事件节流窗口（毫秒）：窗口内多次进度只发最新一帧，完成时补最终值 */
export const TRANSFER_PROGRESS_THROTTLE_MS = 250

/** running 任务的最长静默时长（毫秒）：超过此时长无任何更新即视为失联并移除 */
export const TRANSFER_TASK_STALE_MS = 10 * 60 * 1000

/** 传输任务过期清理周期（毫秒）：周期扫描 TTL/stale，定时器 unref 不阻塞进程退出 */
export const TRANSFER_TASK_SWEEP_MS = 60 * 1000

/** 传输任务字段长度上限（防止异常/恶意 agent 用超长值打爆内存与页面） */
export const TRANSFER_TASK_ID_MAX = 128
export const TRANSFER_TASK_SESSION_ID_MAX = 256
export const TRANSFER_TASK_NAME_MAX = 256
export const TRANSFER_TASK_PATH_MAX = 4096
export const TRANSFER_TASK_ERROR_CODE_MAX = 128

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

/**
 * 补发探针标记前缀：与完成标记**同构但不同 tag**，用于彻底区分
 * 「原命令自己的完成标记」与「shell 回到提示符后补发的探针标记」。
 * 同一会话/同一 seq 两种标记可能先后出现；若不区分，语法误判时会把真实退出码覆盖成 null。
 */
export const PROBE_TAG = "<SSH_PROBE:"

/** shell 类型探测前缀：probeCommand 回显 <前缀>$0 */
export const SHELL_ID_PREFIX = "__SHELL_ID__"

/** 探测输出匹配正则 */
export const SHELL_ID_RE = /\b__SHELL_ID__\b/

/**
 * 独立 HTTP 服务协议/代码版本号：插件的 server/agent 协议或服务端逻辑变更时递增。
 * server-entry 启动时写入 server.json（proto 字段），ensureServer 发现既有服务版本不符时
 * 杀掉旧进程重启，防止 detached 持久进程一直跑旧代码导致行为不生效（如 busy 卡死）。
 * v18：register 增加 running 运行集合（注册时对账僵尸 busy）；状态推送改事件驱动+兜底；空闲关闭改事件驱动。
 * v19：history-only 删除判据、meta.json 标题持久化。
 * v20：新增传输任务事件（agent→server `transfer`，server→web `transfer`/`transfers` 快照）。
 * v21：传输面板改右下浮窗；新增 `transfer-remove` 清理广播与 agent 断线任务失败收尾。
 * v22：传输浮窗默认关闭/开关持久化与 Web 文案修正；强制重启独立服务刷新 Web 资源。
 * v23：Web raw 订阅把“新代次空基线”视为合法清屏，不再回退旧 history。
 */
export const SERVER_PROTO_VERSION = 23
