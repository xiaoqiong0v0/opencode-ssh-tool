// 多语言：工具描述与参数说明的 en/zh 字典，默认英文
// 语言分两类：工具语言（工具描述/CLI/agent·session 文案）与 Web 界面语言（仅页面 UI 文案）

import { LANG_ENV, WEB_LANG_ENV } from "./constants.js"

export type Lang = "en" | "zh"

/** 平铺文案键：值为 en/zh 字符串对的字典键（排除嵌套 args 对象） */
export type FlatKey = { [K in keyof typeof T]: (typeof T)[K] extends Record<Lang, string> ? K : never }[keyof typeof T]

/**
 * 环境变量取值优先于配置（仅接受 en/zh，非法值回退配置）
 * @param env 环境变量原始值
 * @param configured 配置文件语言值
 * @returns 语言标识
 */
function readLang(env: string | undefined, configured: Lang): Lang {
  if (env === "zh" || env === "en") return env
  return configured
}

/**
 * 读取工具语言：环境变量 SSH_TOOL_LANG 优先，否则配置 toolLang（默认 en）
 * @param configured 配置文件 toolLang 值
 * @returns 语言标识
 */
export function getToolLang(configured: Lang = "en"): Lang {
  return readLang(process.env[LANG_ENV], configured)
}

/**
 * 读取 Web 界面语言：环境变量 SSH_WEB_LANG 优先，否则配置 webLang（默认 en）
 * @param configured 配置文件 webLang 值
 * @returns 语言标识
 */
export function getWebLang(configured: Lang = "en"): Lang {
  return readLang(process.env[WEB_LANG_ENV], configured)
}

/** 工具描述与参数说明字典 */
export const T = {
  submitted: {
    en: "Command submitted (this call did not wait for the result). It is still running in the terminal's foreground: use term_cli status to check completion, then term_cli read to read output.",
    zh: "命令已提交（本次调用未等待结果），命令仍在该终端前台执行：用 term_cli status 查完成状态，再用 term_cli read 读取输出。",
  },
  send_ok: {
    en: "Sent: {text}",
    zh: "已发送：{text}",
  },
  send_ok_source: {
    en: "Sent ({source}, {length} chars; content hidden)",
    zh: "已发送（{source}，{length} 字符，内容不回显）",
  },
  local_connect_ok: {
    en: "Started: {cmd} (terminal {name})",
    zh: "已启动：{cmd}（终端 {name}）",
  },
  local_connect_title_fail: {
    en: "Local terminal start failed",
    zh: "本地终端启动失败",
  },
  local_start_epipe: {
    en: "Shell exited immediately after start (EPIPE). On Windows, avoid the bare Microsoft Store alias: use \"pwsh.exe -NoLogo\" or \"powershell\".",
    zh: "shell 启动后立即退出（EPIPE）。Windows 上请避免裸 Store 别名：改用 \"pwsh.exe -NoLogo\" 或 \"powershell\"。",
  },
  local_start_not_found: {
    en: "Executable not found in the service PATH: {cmd}. Use a path without spaces, or \"powershell\".",
    zh: "service 的 PATH 找不到可执行文件：{cmd}。请改用不含空格的全路径，或 \"powershell\"。",
  },
  term_cli: {
    en: "Unified terminal CLI: SSH / local shell (wsl, pwsh, bash) / container (docker exec); use 'local' for local terminals instead of bash. Subcommands: connect / local / exec / read / send / upload / download / status / disconnect / help; use 'help' for usage. Long-running, stdin-reading or interactive commands: use the default submit, then status/read; never add -w. upload/download use SFTP and require an SSH session. Terminal sessions are scoped to this opencode session: restarting/ending opencode closes them; reconnect after restart. connect/local default to name 'default'; reusing a name (also across SSH/local) closes the old terminal first (running command lost; failed connect does not restore it). Use exec on an existing terminal; use distinct -n names to keep terminals separate.",
    zh: "统一终端 CLI：SSH / 本地 shell（wsl、pwsh、bash）/ 容器（docker exec）；本地终端用 'local'，不要用 bash 直接跑。子命令：connect / local / exec / read / send / upload / download / status / disconnect / help；用 'help' 查看用法。长命令、需 stdin 或交互的命令：用默认提交后 status/read；禁止 -w。upload/download 走 SFTP，仅支持 SSH 会话。终端会话仅属于当前 opencode 会话，重启或退出 opencode 会关闭，需重新连接。connect/local 未传 -n 时名为 default；同名（包括 SSH 与 local 之间）会先关闭旧终端（运行中命令丢失，新连接失败也不恢复）。已有终端用 exec；并行保留用不同 -n。",
  },
  term_cli_args: {
    en: "Full command line string, e.g. 'local \"wsl bash\"' / 'exec \"ls -la\"' / 'connect user@host' / 'upload ./a.txt ~/a.txt'; defaults to 'help' when empty.",
    zh: "完整命令行字符串，如 'local \"wsl bash\"' / 'exec \"ls -la\"' / 'connect user@host' / 'upload ./a.txt ~/a.txt'；空时默认 'help'。",
  },
  term_cli_help: {
    en: `term_cli unified CLI tool: manage SSH / local (wsl, pwsh, bash) / container (docker exec) terminal sessions.
Use 'local' for any terminal started on this machine (WSL, Docker containers, local shells).
Terminal sessions belong to the current opencode session; restarting or ending opencode closes them. Reconnect with connect/local; this is expected, not a crash.
-n defaults to "default". connect/local with an existing name (also across SSH/local) closes that terminal before attempting the new connection; its running command is lost, and a failed new connection does not restore it. Use exec for more commands in an existing terminal; use distinct -n values to keep terminals separate.

Usage: term_cli <subcommand> [args]

Subcommands:
  connect <target> [-u user] [-n name] [-p password|file:path]
      target = user@host[:port] (e.g. root@server.local:22); open a long-lived SSH session
      -p accepts plain text or file:<path> (read password from file, avoids exposure)
  local "<command>" [-n name] [-c cwd]
      start a local/container terminal (e.g. "pwsh" / "docker exec -it <container> sh")
  exec "<command>" [--base64 | --file <path>] [-n name] [-w]
      run a command in the terminal (default: submit and return immediately without waiting for the result; -w waits until the command actually finishes — use it only for commands expected to finish quickly; NEVER use -w for long-running / stdin-reading / interactive / server / watch / tail -f / build / install / scan / REPL commands, because -w keeps waiting as long as the command runs and can hang indefinitely; use the default and poll with status/read)
  read [-n name] [-s buffer|history] [-l limit] [--head] [--includeCommand]
      read terminal output: with no -s, a running command returns a current buffer snapshot (may be partial) and an idle terminal returns history; -s buffer reads the live buffer; -s history reads completed history. read never waits for completion: use status to wait, then read the final result
  send "<text>" [--base64 | --file <path>] [-n name]
      send text/keystrokes (\\xHH any hex byte, \\t Tab, \\r/\\n Enter, \\x03 Ctrl-C, \\x04 Ctrl-D, \\x1a Ctrl-Z, \\x1b Esc)
  upload <local> <remote> [-n name] [--overwrite] [--mkdir]
      upload a regular file from this machine to the SSH session over SFTP
      local supports ~; remote supports absolute or home-relative paths and ~/ (expanded by SFTP, no shell; ~user unsupported); Windows drive paths must use forward slashes (C:/dir/file)
      fails if the target exists unless --overwrite; parents are not created unless --mkdir
      SSH sessions only; directories and symlinks are rejected; max 256 MiB
  download <remote> <local> [-n name] [--overwrite] [--mkdir]
      download a regular file over SFTP; same path/overwrite/mkdir/size rules
  status [-n name]
      terminal state (busy/pending/connection); omit name to list all
  disconnect [-n name]
      close terminal; omit name to close all
  help
      show this help

Payload input (exec / send):
  --base64           decode base64 (whitespace ignored) to strict UTF-8 text; send sends it raw (no \\n / \\xHH decoding), exec executes it as a command
  --file <path>      read a LOCAL UTF-8 file on this machine (not remote); send sends it raw, exec executes it as a command; strips BOM, rejects NUL; ~ is expanded
  --                 end option parsing: exec -- "-x" / send -- "-n" (payload starting with "-")
  For complex quotes or shell-specific escaping, prefer --base64 / --file over guessing outer quotes.

Examples:
  term_cli connect root@192.168.1.10
  term_cli connect user@host -p file:C:\\secrets\\pw.txt
  term_cli local "docker exec -it myctr bash" -n db
  term_cli exec "ls -la"
  term_cli exec "cd /var/log && tail -50 syslog"
  term_cli exec -- "-x"
  term_cli exec --base64 "bHMK"
  term_cli send --file ./payload.txt -n db
  term_cli send "mypass\\r" -n default
  term_cli upload ./dist/app.tgz /opt/app/app.tgz --overwrite
  term_cli download ~/logs/app.log ./app.log --mkdir
  term_cli read -n db -s buffer
  term_cli status
  term_cli disconnect -n db
`,
    zh: `term_cli 统一命令行工具：管理 SSH / 本地（wsl、pwsh、bash）/ 容器（docker exec）终端会话。
本机可启动的终端（WSL、Docker 容器、本地 shell）一律用 'local' 子命令。
终端会话绑定当前 opencode 会话；重启或退出 opencode 后旧终端会关闭，需重新 connect/local；这是正常生命周期，不是崩溃。
-n 默认 default；connect/local 遇到同名终端（包括 SSH 与 local 之间）会先关闭旧终端再尝试新连接，其中正在运行的命令会丢失，新连接失败也不会恢复旧终端。已有终端继续执行命令请用 exec；需要并行保留请用不同的 -n。

用法: term_cli <子命令> [参数]

子命令:
  connect <target> [-u user] [-n name] [-p password|file:path]
      target = user@host[:port]（如 root@server.local:22）；建立 SSH 长驻会话
      -p 支持明文或 file:<路径>（从文件读密码，避免暴露）
  local "<command>" [-n name] [-c cwd]
      启动本地/容器终端（如 "pwsh" / "docker exec -it <容器> sh"）
  exec "<command>" [--base64 | --file <path>] [-n name] [-w]
      在指定终端执行命令（默认：提交后立即返回、不等结果；-w 等到命令真正结束 —— 只适用于预期很快结束的命令；**禁止**对长时间运行 / 需要 stdin / 交互 / server / watch / tail -f / 构建 / 安装 / 扫描 / REPL 命令加 -w：只要命令没结束 -w 就会一直等，可能永久阻塞；这些命令请用默认模式，再用 status/read 轮询）
  read [-n name] [-s buffer|history] [-l limit] [--head] [--includeCommand]
      读终端输出：不传 -s 时，命令运行中返回当前 buffer 快照（可能不完整），空闲时返回 history；-s buffer 读实时 buffer；-s history 读已完成历史。read 不等待命令完成：先用 status 等完成，再读最终结果
  send "<text>" [--base64 | --file <path>] [-n name]
      发送文本/按键（\\xHH 任意十六进制字节、\\t Tab、\\r/\\n 回车、\\x03 Ctrl-C、\\x04 Ctrl-D、\\x1a Ctrl-Z、\\x1b Esc）
  upload <local> <remote> [-n name] [--overwrite] [--mkdir]
      通过 SFTP 把本机普通文件上传到 SSH 会话
      local 支持 ~；remote 支持绝对路径、相对 home 路径与 ~/（由 SFTP 展开，不经过 shell；不支持 ~user）；Windows 盘符路径必须用正斜杠（C:/dir/file）
      目标已存在默认失败，需加 --overwrite；默认不建父目录，需加 --mkdir
      仅支持 SSH 会话；目录与符号链接会被拒绝；单文件上限 256 MiB
  download <remote> <local> [-n name] [--overwrite] [--mkdir]
      通过 SFTP 下载普通文件；路径/覆盖/建目录/大小规则相同
  status [-n name]
      终端状态（busy/pending/连接）；省略 name 列出全部
  disconnect [-n name]
      断开终端；省略 name 断开全部
  help
      显示本帮助

载荷输入（exec / send）:
  --base64           解码 base64（忽略空白）为严格 UTF-8 文本；send 原样发送（不再解释 \\n / \\xHH 等转义），exec 作为命令执行
  --file <path>      读取本机的 UTF-8 文件（不是远程文件）；send 原样发送，exec 作为命令执行；剥 BOM、拒绝 NUL；支持 ~ 展开
  --                 终止选项解析：exec -- "-x" / send -- "-n"（载荷以 "-" 开头时）
  复杂引号或目标 shell 专属转义，优先用 --base64 / --file，不要在外层引号里猜转义。

示例:
  term_cli connect root@192.168.1.10
  term_cli connect user@host -p file:C:\\secrets\\pw.txt
  term_cli local "docker exec -it myctr bash" -n db
  term_cli exec "ls -la"
  term_cli exec "cd /var/log && tail -50 syslog"
  term_cli exec -- "-x"
  term_cli exec --base64 "bHMK"
  term_cli send --file ./payload.txt -n db
  term_cli send "mypass\\r" -n default
  term_cli upload ./dist/app.tgz /opt/app/app.tgz --overwrite
  term_cli download ~/logs/app.log ./app.log --mkdir
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
    en: "Usage: exec \"<command>\" [--base64 | --file <path>] [-n name] [-w]",
    zh: "用法: exec \"<command>\" [--base64 | --file <path>] [-n name] [-w]",
  },
  cli_send_usage: {
    en: "Usage: send \"<text>\" [--base64 | --file <path>] [-n name]",
    zh: "用法: send \"<text>\" [--base64 | --file <path>] [-n name]",
  },
  cli_need_command: {
    en: "Need a command",
    zh: "需要命令",
  },
  cli_need_text: {
    en: "Need text to send",
    zh: "需要发送内容",
  },
  payload_conflict: {
    en: "Use either --base64 or --file, not both.",
    zh: "只能二选一：--base64 或 --file。",
  },
  payload_bad_base64: {
    en: "Invalid base64 payload.",
    zh: "base64 载荷不合法。",
  },
  payload_bad_encoding: {
    en: "Payload is not valid UTF-8 (or contains NUL); save it as UTF-8.",
    zh: "载荷不是合法 UTF-8（或含 NUL）；请保存为 UTF-8。",
  },
  payload_file_error: {
    en: "Cannot read file: {path}",
    zh: "无法读取文件：{path}",
  },
  cli_need_transfer_paths: {
    en: "Need a local path and a remote path",
    zh: "需要本地路径和远端路径",
  },
  cli_upload_usage: {
    en: "Usage: upload <local> <remote> [-n name] [--overwrite] [--mkdir]",
    zh: "用法: upload <local> <remote> [-n name] [--overwrite] [--mkdir]",
  },
  cli_download_usage: {
    en: "Usage: download <remote> <local> [-n name] [--overwrite] [--mkdir]",
    zh: "用法: download <remote> <local> [-n name] [--overwrite] [--mkdir]",
  },
  upload_ok: {
    en: "Uploaded {local} -> {remote} ({bytes} bytes, {ms} ms)",
    zh: "已上传 {local} -> {remote}（{bytes} 字节，{ms} ms）",
  },
  download_ok: {
    en: "Downloaded {remote} -> {local} ({bytes} bytes, {ms} ms)",
    zh: "已下载 {remote} -> {local}（{bytes} 字节，{ms} ms）",
  },
  transfer_denied: {
    en: "Transfer denied by user.",
    zh: "用户已拒绝传输。",
  },
  transfer_err_exists: {
    en: "{path} already exists. Add --overwrite to replace it (no auto-rename/backup).",
    zh: "{path} 已存在。需要覆盖请加 --overwrite（不会自动改名或备份）。",
  },
  transfer_err_local_missing: {
    en: "Local file not found: {path}",
    zh: "本地文件不存在：{path}",
  },
  transfer_err_local_is_dir: {
    en: "Local path is a directory (only regular files are supported): {path}",
    zh: "本地路径是目录（只支持普通文件）：{path}",
  },
  transfer_err_remote_missing: {
    en: "Remote file not found: {path}",
    zh: "远端文件不存在：{path}",
  },
  transfer_err_remote_is_dir: {
    en: "Remote path is a directory (only regular files are supported): {path}",
    zh: "远端路径是目录（只支持普通文件）：{path}",
  },
  transfer_err_symlink: {
    en: "Symbolic links are not supported: {path}",
    zh: "不支持符号链接：{path}",
  },
  transfer_err_parent_missing: {
    en: "Parent directory does not exist: {path}. Add --mkdir to create it.",
    zh: "父目录不存在：{path}。需要创建请加 --mkdir。",
  },
  transfer_err_too_large: {
    en: "File is too large for v1 transfer: {path} (limit {limit}).",
    zh: "文件超过 v1 传输上限：{path}（上限 {limit}）。",
  },
  transfer_err_sftp_unavailable: {
    en: "SFTP is unavailable on this SSH session. Reconnect with term_cli connect and retry.",
    zh: "该 SSH 会话的 SFTP 不可用。请用 term_cli connect 重新连接后重试。",
  },
  transfer_err_timeout: {
    en: "Transfer timed out ({seconds}s). The transfer was aborted; the target file or a temporary file may be partially written.",
    zh: "传输超时（{seconds}s）。传输已中止；目标文件或临时文件可能残留部分内容。",
  },
  transfer_err_io: {
    en: "Transfer failed: {reason}",
    zh: "传输失败：{reason}",
  },
  transfer_err_unsupported: {
    en: "Only regular files are supported (not {path}).",
    zh: "只支持普通文件（{path} 不是普通文件）。",
  },
  transfer_err_tilde_user: {
    en: "~user paths are not supported; use ~/ (current user) or an absolute path: {path}",
    zh: "不支持 ~user 路径；请用 ~/（当前用户）或绝对路径：{path}",
  },
  transfer_err_remote_path_backslash: {
    en: "Remote Windows paths must use forward slashes (e.g. C:/dir/file); backslash drive paths are rejected: {path}",
    zh: "远端 Windows 路径必须用正斜杠（如 C:/dir/file）；反斜杠盘符路径已拒绝：{path}",
  },
  transfer_err_ssh_only: {
    en: "File transfer is only supported on SSH sessions (term_cli connect); local/container sessions cannot transfer files.",
    zh: "文件传输仅支持 SSH 会话（term_cli connect）；本地/容器会话不能传文件。",
  },
  cli_unknown: {
    en: "Unknown command: {cmd}",
    zh: "未知命令: {cmd}",
  },
  cli_unclosed_quote: {
    en: "Unclosed quote in term_cli args; command not sent.",
    zh: "term_cli 参数中有未闭合引号，命令未发送。",
  },
  st_name: { en: "name", zh: "名称" },
  st_type: { en: "type", zh: "类型" },
  st_connected: { en: "connected", zh: "已连接" },
  st_busy: { en: "busy", zh: "忙碌" },
  st_pending: { en: "pending", zh: "待读" },
  st_bytes: { en: "bytes", zh: "字节" },
  st_host: { en: "host", zh: "主机" },
  st_program: { en: "program", zh: "程序" },
  st_last_active: { en: "lastActive", zh: "最后活动" },
  st_connected_at: { en: "connectedAt", zh: "连接时间" },
  st_http_server: { en: "httpServer", zh: "HTTP 服务" },
  st_active_sessions: { en: "activeSessions", zh: "活跃会话" },
  st_disabled: { en: "disabled", zh: "已禁用" },
  st_server_unavailable: { en: "not started (commands unaffected)", zh: "未启动（命令执行不受影响）" },
  denied_danger: {
    en: "Dangerous command, execution rejected.",
    zh: "危险命令，已拒绝执行。",
  },
  not_connected: {
    en: "No active terminal. Terminal sessions are tied to the current opencode session; after an opencode restart, reconnect with term_cli connect (SSH) or term_cli local.",
    zh: "无活动终端。终端会话绑定当前 opencode 会话；重启 opencode 后请重新用 term_cli connect（SSH）或 term_cli local 建立。",
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
    en: "No active terminals. Terminal sessions are tied to the current opencode session; after an opencode restart, reconnect with connect/local.",
    zh: "当前没有活动的终端会话。终端会话绑定当前 opencode 会话；重启 opencode 后请重新 connect/local。",
  },
  connect_ok: {
    en: "Connected: {user}@{host}:{port} (session {sid}, terminal {name})",
    zh: "连接成功：{user}@{host}:{port}（session {sid}，终端 {name}）",
  },
  connect_title_fail: {
    en: "SSH connection failed",
    zh: "SSH 连接失败",
  },
  connect_conflict: {
    en: "Another terminal with this name was connected concurrently. Wait for it to finish, or retry with a different -n.",
    zh: "同名终端正在并发连接。请等它完成，或改用不同的 -n 重试。",
  },
  connect_cancelled: {
    en: "The terminal set was closed while connecting. Reconnect and retry.",
    zh: "连接期间终端集合已被关闭，请重新连接后重试。",
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
    en: "Terminal disconnected",
    zh: "终端已断开",
  },
  status_busy_hint: {
    en: "\nHint: a command is still running. Wait and retry, or call term_cli read for partial output. Do not re-run it with -w.",
    zh: "\n提示：已有命令在运行。等它结束，或直接用 term_cli read 读取部分输出；不要用 -w 重跑。",
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
  server_unavailable: {
    en: "\n(Web record service not started; command execution is unaffected)",
    zh: "\n（Web 记录服务未启动，命令执行不受影响）",
  },
  history_title: {
    en: "Terminal history (last {n} / total {total})",
    zh: "终端历史（最后 {n} 条 / 共 {total} 条）",
  },
  history_title_head: {
    en: "Terminal history (first {n} / total {total})",
    zh: "终端历史（前 {n} 条 / 共 {total} 条）",
  },
  read_busy_buffer_notice: {
    en: "[read source=buffer busy=true]\nWarning: this is a partial buffer snapshot, not the final result; run status and wait for completion before reading the final result.",
    zh: "[read source=buffer busy=true]\n警告：这是 buffer 部分快照，不是最终结果；请先用 status 等待命令完成后再读取最终结果。",
  },
  read_busy_history_notice: {
    en: "[read source=history busy=true]\nWarning: history only contains completed commands; it does not include the current result.",
    zh: "[read source=history busy=true]\n警告：history 只含已完成命令，不含当前结果。",
  },
  web_title: { en: "Terminal Records", zh: "终端记录" },
  web_close: { en: "Close", zh: "关闭" },
  web_loading: { en: "Loading...", zh: "加载中..." },
  web_session_gone: { en: "Session not found or disconnected", zh: "会话不存在或已断开" },
  web_time: { en: "Time", zh: "时间" },
  web_terminals: { en: "terminals", zh: "终端" },
  web_transfers: { en: "Transfers", zh: "传输任务" },
  web_transfers_empty: { en: "No transfers for this terminal.", zh: "当前终端暂无传输任务。" },
  web_transfer_upload: { en: "Upload", zh: "上传" },
  web_transfer_download: { en: "Download", zh: "下载" },
  web_transfer_running: { en: "running", zh: "传输中" },
  web_transfer_done: { en: "done", zh: "完成" },
  web_transfer_failed: { en: "failed", zh: "失败" },
  web_local: { en: "local", zh: "本地" },
  web_commands: { en: "commands", zh: "条命令" },
  web_no_session: { en: "No terminal. Use term_cli connect (SSH) or term_cli local first.", zh: "无终端会话，请先用 term_cli connect（SSH）或 term_cli local 建立。" },
  web_new_messages: { en: "↓ New messages", zh: "↓ 新消息" },
  web_delete_terminal: { en: "Delete disconnected terminal", zh: "删除已断开终端" },
  web_delete_refused_recent: {
    en: "Not deleted: terminal still active (state file not stale yet); it may belong to another running opencode instance.",
    zh: "未删除：该终端仍在活动（状态文件尚未陈旧），可能属于其他正在运行的 opencode 实例。",
  },
  web_delete_refused_active: {
    en: "Not deleted: this terminal is still in use by another online instance.",
    zh: "未删除：该终端仍被其他在线实例占用。",
  },
  web_delete_blocked: {
    en: "Cannot delete this terminal (still active or owned by another instance).",
    zh: "无法删除该终端（仍在活动或属于其他实例）。",
  },
  web_delete_failed: { en: "Delete failed.", zh: "删除失败。" },
  web_cmd_placeholder: { en: "Enter command (Shift+Enter new line)", zh: "输入命令（Shift+Enter 换行）" },
  web_direct_input: { en: "Direct input (type here for interactive prompts)", zh: "直接输入（交互输入请直接在此输入）" },
  web_input_on: { en: "Direct input: ON — keys go to terminal", zh: "直接输入：已启用（按键发往终端）" },
  web_input_off: { en: "Direct input: OFF — keys stay in browser", zh: "直接输入：已关闭（按键留在浏览器）" },
  web_input_disconnected: { en: "Disconnected — input will not be sent", zh: "连接已断开，输入不会被送达" },
  web_input_offline: { en: "Terminal offline — input will not be sent", zh: "终端未连接，输入不会被送达" },
  web_raw: { en: "Raw", zh: "原始" },
  disconnected_ok: {
    en: "Terminal closed ({host}).",
    zh: "终端已断开（{host}）。",
  },
  disconnected_ok_local: {
    en: "Terminal closed ({program}).",
    zh: "终端已断开（{program}）。",
  },
  disconnected_all_ok: {
    en: "All terminals closed (last host {host}).",
    zh: "已断开全部终端（最后主机 {host}）。",
  },
  disconnected_all_ok_local: {
    en: "All terminals closed (last program {program}).",
    zh: "已断开全部终端（最后程序 {program}）。",
  },
  err_not_connected: {
    en: "Not connected",
    zh: "未连接",
  },
  cmd_busy: {
    en: "Previous command still running; poll with `term_cli status` first",
    zh: "上一条命令仍在运行，请先用 `term_cli status` 查询状态",
  },
  cmd_continuation: {
    en: "Command would enter shell continuation (unclosed quote/backtick/escape); aborted",
    zh: "命令会导致 shell 进入续行等待（引号/反引号/转义未闭合），已中止",
  },
  precheck_failed: {
    en: "Pre-exec syntax check failed",
    zh: "发送前语法校验失败",
  },
  precheck_entry: {
    en: "ErrorId={errorId} at line {line} col {col} fragment={fragment}",
    zh: "ErrorId={errorId} 位置=行{line}列{col} 片段={fragment}",
  },
  precheck_more: {
    en: "… ({n} total)",
    zh: "…（共 {n} 处）",
  },
  shell_probe_timeout: {
    en: "Shell probe timed out (shell not ready within 30s); connection aborted",
    zh: "Shell 探测超时（30s 内 shell 未就绪），连接终止",
  },
} as const

/** 取某语言下的一条文案 */
export function tr(key: FlatKey, lang: Lang): string {
  return T[key][lang]
}
