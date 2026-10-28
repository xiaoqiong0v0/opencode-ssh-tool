# opencode-ssh-tool

opencode 插件：让 opencode 像人一样操作**长驻交互式终端会话**——远程 SSH（ssh2 PTY）与本地/容器（Bun.Terminal，如 `pwsh`、`docker exec -it`）。连接一次，后续在会话里连续执行命令，保留当前目录、环境变量、交互状态；命令执行同样受 opencode 权限系统管控（类似内置 Bash 工具的审批）。

## 特性

- **长驻会话（绑定当前 opencode 会话）**：`term_cli connect` 建立连接后，`term_cli exec` 在同一会话执行命令，保留 cwd/环境/后台进程/sudo 缓存；重启或退出 opencode 后旧终端会关闭，需重新 `connect`/`local`，属于正常生命周期，不是崩溃
- **PTY 交互**：分配伪终端，可处理 sudo 密码、vi、top 等交互程序
- **权限管控**：只读白名单直接放行、危险命令黑名单硬拒、其余走 `context.ask()` 用户审批
- **命令完成判定**：支持长命令前台运行；不设超时强杀，Ctrl-C 可中断并收尾；语法错误安静收尾；未闭合引号/反引号等会触发 shell 续行的命令提交前拦截；断连有兜底
- **发送前语法预检**：本地/远程 `bash`/`zsh`/`pwsh` 在发送前检查 shell 语法，命中即拦、不写入终端；`cmd` 跳过。**只查 shell 语法，不查 Python/Node 等程序代码**
- **SFTP 文件传输（v1）**：`term_cli upload` / `download` 通过 SSH/SFTP 传普通文件（不使用 exec/scp/base64/PTY）。默认用**独占创建**（远端 `wx` / 本地 `wx`）保证目标存在即失败，`--overwrite` 才走临时文件 + rename 覆盖，`--mkdir` 才建父目录；仅 SSH 会话（本地/容器明确拒绝）；单文件上限 256 MiB；目录与符号链接拒绝；文件内容不进模型上下文、终端历史与日志
- **双视图**：transcript（命令+输出消息对）与 raw（xterm.js 实时画面，支持 vi/top 等全屏程序）；终端尺寸前后端一致固定 `120×40`
- **直接输入（焦点驱动）**：浏览器内直接向交互式程序输入。默认「命令框优先」——按键留在浏览器，回车走 `exec` 提交命令；点终端区域（transcript `#term` / raw `#xt`）或入口按钮 `#cmdKey` 切换为直接输入，按键按**真实控制字节**经 `send` keystroke 通道发往终端（**不产生 `exec`、不写命令记录**）；焦点回到命令框等可编辑控件即自动关闭；状态**不持久化**，每次打开都从命令框优先开始；离线/断线时入口不可点击、按键一律不发送
- **SSH 保活 + WS 心跳**：SSH 层按 `ServerAliveInterval` 语义定期发 `keepalive@openssh.com`（连接层**带外**消息，不写 channel/PTY），连续 3 次无响应判连接死亡并断连；WS 层 server 每 25s 下发 `ping`、10s 无 `pong` 判半开并断开，客户端静默超 2×间隔即主动断开重连——**保活与心跳都不写入 PTY，不污染终端输出与完成标记**
- **历史消息对**：命令+输出 全部存文件（`~/.opencode/plugins-cache/opencode-ssh-tool/<会话>/`），按对数保留（默认 100 对），opencode 重启不丢、会话关闭清理；终端连接本身不跨 opencode 重启，需重新建立
- **HTTP 终端查看**：默认开启本地服务，浏览器打开可查看终端记录（WebSocket 实时推送，无轮询）
- **多语言**：`toolLang`（工具描述/CLI/session 文案）与 `webLang`（页面 UI）独立配置，默认英文；环境变量 `SSH_TOOL_LANG` / `SSH_WEB_LANG` 分别覆盖

## 安装

```jsonc
// opencode.json
{
  "plugin": ["@xiaoqiong0v0/opencode-ssh-tool"]
}
```

发布到 npm 后通过 `plugin` 数组引用；或本地调试时挂载到项目 `.opencode/` 文件夹。

## 工具

| 工具 | 入参 | 行为 |
|---|---|---|
| `term_cli` | `args`（完整命令行字符串） | **CLI 风格单工具**：SSH / 本地 / 容器终端会话。子命令：`connect` / `local` / `exec` / `read` / `send` / `upload` / `download` / `status` / `disconnect` / `help`；用 `help` 查看完整用法 |

```text
term_cli connect root@host:22 [-n name] [-p password|file:path]   # SSH 连接
term_cli local "pwsh|docker exec -it <容器> sh" [-n name] [-c cwd] # 本地/容器终端
term_cli exec "<command>" [--base64 | --file <path>] [-n name] [-w]  # 执行命令（默认提交后立即返回；-w 只用于已知很快结束的命令；禁止对 server/watch/tail -f/构建/安装/扫描/交互命令用 -w）
term_cli read [-n name] [-s buffer|history] [-l limit] [--head] [--includeCommand]  # 读输出（未传 -s：运行中返回当前快照、空闲读历史；read 不等待完成）
term_cli send "<text>" [--base64 | --file <path>] [-n name]         # 发送按键（sudo 密码等）
term_cli upload <local> <remote> [-n name] [--overwrite] [--mkdir]  # SFTP 上传（仅 SSH）
term_cli download <remote> <local> [-n name] [--overwrite] [--mkdir] # SFTP 下载（仅 SSH）
term_cli status [-n name]                                         # 状态
term_cli disconnect [-n name]                                     # 断开
term_cli help                                                     # 完整用法
```

> 复杂引号 / 目标 shell 转义 / 以 `-` 开头的载荷：`--base64` 会忽略空白后解码为 UTF-8 文本，`--file <path>` 读取**插件进程本机**的 UTF-8 文件（不是远程文件），二者互斥；两者都严格按 UTF-8 解码（剥掉开头的 BOM，非法 UTF-8 / 含 NUL 的 UTF-16 或二进制文件直接报错，不会静默发送）。**`send` 原样**交给终端（不再解释 `\n` / `\xHH` 等转义）；**`exec` 仍按 shell 命令执行**。选项终止用 `--`：`term_cli exec -- "-x"`、`term_cli send -- "-n"`。复杂引号场景优先 base64/file，不要在外层引号里猜转义。

> 一个 opencode 会话可创建**多个命名终端**（如 `db`、`web`、`prod`），用不同 `name` 并行维护；同名重复创建会先关闭旧的。终端只属于当前 opencode 会话：重启/退出 opencode 后旧终端会关闭，需要重新 connect/local。工具只暴露一个 `args` 字符串参数，模型像敲命令行一样调用，`help` 引导其学会所有用法（单工具多命令模式，省 token）。

> **read 语义（v0.7.3）**：未显式传 `-s` 时，命令仍在运行（`busy=true`）返回当前 buffer 快照（可能只有部分输出），并加 `[read source=buffer busy=true]` 警告；空闲（`busy=false`）读 history。**显式 `-s buffer` 读实时 buffer；`-s history` 只含已完成命令**。`read` 不等待命令完成：要等结果先 `term_cli status` 确认 `busy=false`，再 `read` 取最终结果。内部实现细节见 `docs/design/read读取语义说明.md`。

## 文件传输（v1）

```text
term_cli upload <local> <remote> [-n name] [--overwrite] [--mkdir]
term_cli download <remote> <local> [-n name] [--overwrite] [--mkdir]
```

- 只走 SSH/SFTP subsystem（`client.sftp()`），**不用** exec/scp/base64/PTY；传输不占用 PTY、不置 busy
- 仅 SSH 会话：`LocalSession`（docker/wsl 等）返回明确的“仅支持 SSH 会话”错误，不假装可传
- `local` 是**插件进程本机**路径（支持 `~`）；`remote` 是远端路径（绝对 / 相对 home / `~/`），`~` 由 SFTP `realpath(".")` 展开，**不经过 shell**；不支持 `~user`，Windows 远端盘符路径必须用正斜杠（`C:/dir/file`），反斜杠盘符路径直接拒绝
- 默认目标已存在即失败（`exists`）：上传用远端 `flags: "wx"`、下载用本地 `flags: "wx"`（先 `open` 独占创建再流式写入）。**预检只用于错误归类，真正“不覆盖”由 `wx` 的独占创建保证**；不自动改名/备份；只有显式 `--overwrite` 才覆盖
- `--overwrite` 才使用同目录临时文件（`.name.opencode-ssh-tool-<随机>.part`）+ rename：同目录 rename（同一文件系统内）提交；若直接 rename 未成功且确认旧目标存在，再走“备份旧目标（`.bak`）→ 新文件就位 → 删备份”。失败时**尽力回滚**旧目标；回滚失败时旧目标保留在 `.bak` 备份路径，错误文案会给出该路径（不会静默空出原路径）
- 默认不建父目录（`parent_missing`）；`--mkdir` 递归创建（远端/本地都逐级创建）
- 只传普通文件；目录、符号链接拒绝；单文件上限 256 MiB（`MAX_TRANSFER_BYTES`），运行时也按实际读写字节强制
- **整个传输共用一个 deadline**（默认 10 分钟，`TRANSFER_TIMEOUT_MS`）：开 SFTP 通道、realpath/stat/mkdir、读写流、rename 都受约束；超时中止通道、销毁流，**不主动发起新的 rename/commit**（但已发出的 rename 仍可能被服务端执行）。无 `--overwrite` 时**目标路径本身**可能残留半截文件（重试会报 `exists`），`--overwrite` 时可能残留 `.part`/`.bak`；错误文案已说明
- 同一终端会话的传输串行执行（避免同目标竞争）；与 PTY 命令互不影响；并发契约见 `docs/ASYNC.md`
- 权限：`file_upload` / `file_download` 在传输前走 `context.ask()`（参数含本地与远端路径、`overwrite`/`mkdir`；`always` 键也区分这两个选项，避免“总是允许”普通上传后同路径 `--overwrite` 不再询问）；拒绝即不传
- 日志只记方向/路径/实际字节/耗时/ok/错误码；**文件内容不进**日志、终端历史、模型上下文
- **传输任务**：Web 可查看上传/下载任务的进度、状态与耗时；完成/失败保留 10 分钟；只展示元数据，不含文件内容。

## 配置

配置文件 `~/.config/opencode/ssh-tool.jsonc`（首次运行自动生成）：

```jsonc
{
  // HTTP 终端记录服务开关（默认 true）
  "server": {
    "enabled": true,
    // 端口：默认 0（随机端口，推荐，避免冲突）；可显式指定，如 8137
    "port": 0
  },
  // 会话记录（命令+输出 消息对）管理：全部存文件（~/.opencode/plugins-cache/opencode-ssh-tool/<会话>/），随会话清理
  "history": {
    // 保留的消息对数上限（默认 100，最小 1）。超出时移除最旧的一对
    "maxMessages": 100
  },
  // 工具语言（工具描述 / CLI / agent·session 文案）："en" | "zh"（默认 "en"，可用环境变量 SSH_TOOL_LANG 覆盖）
  "toolLang": "en",
  // Web 界面语言（仅浏览器页面 UI 文案）："en" | "zh"（默认 "en"，可用环境变量 SSH_WEB_LANG 覆盖）
  "webLang": "en",
  // 中断探针补发间隔（秒，默认 5）：Ctrl+C 后立即补发首条探针，之后每隔该秒数补发一次，直到命令结束
  // 仅用于周期性重发探针，不判命令完成；非法值（非数字 / ≤0）回退默认 5
  "interruptProbeInterval": 5,
  // 权限自定义正则（追加到内置默认，控制"拒绝"与"需审批"命令）
  "permission": {
    // 内置默认危险命令黑名单（命中直接拒绝）：
    //   rm 危险目标(/ ~ . /etc /var /usr 等) | shutdown/reboot/halt/poweroff | mkfs/mkswap/fdisk/parted/dd
    //   iptables/ufw/firewall-cmd | systemctl | service stop/restart/kill | kill/killall/pkill
    //   passwd/useradd/userdel/groupadd/groupdel | chown -R | chmod -R 777 / | apt remove | npm uninstall
    //   DROP TABLE/TRUNCATE/DROP DATABASE | fork炸弹 | > /etc/{passwd,shadow,sudoers,fstab}
    //   curl|sh / wget|sh / base64 -d |
    // 自定义补充示例：["^mkfs\\s", "^dd\\s"]（空数组 = 仅使用内置默认）
    "deny": [],
    // 内置默认只读白名单（命中且无 shell 元字符则直接放行）：
    //   ls | cd | cat | grep | tail | head | ps | df | free | pwd | env | echo | curl | wget | git status | whoami | hostname | date | uname | uptime
    // 自定义补充示例：["^df\\s.*-h$"]（空数组 = 仅使用内置默认）
    "allow": []
  }
}
```

多语言：`toolLang` 控制工具侧全部文案（工具描述、CLI 输出、agent/session 回传消息），`webLang` 仅控制浏览器页面 UI。优先级均为「环境变量 > 配置文件 > 默认 `en`」：工具用 `SSH_TOOL_LANG`，Web 用 `SSH_WEB_LANG`。

权限自定义正则**追加**到内置默认（`DENY` 黑名单 + `ALLOW_READONLY` 白名单），`deny`/`allow` 为空数组时仅用内置默认规则，可自行补充扩展。

## 认证

按优先级自动选择，认证信息**不硬编码**、不落日志：

1. **SSH key**（推荐）：用户默认私钥（`id_ed25519` / `id_rsa`）
2. **SSH agent**：agent socket / Windows OpenSSH agent
3. **环境变量密码**：`SSH_PASS_<HOST大写>` 优先，回退 `SSH_PASSWORD`

> [!WARNING] 风险警告
> `term_cli connect` 的 `password` 参数（明文或 `file:` 路径）允许模型直接凭密码建立连接，**绕过密钥认证，一旦建立便无法像正常会话那样可靠授权与撤销**——远程主机上的命令操作难以被 opencode 权限系统有效管控。
>
> **最佳用途**：仅用于一次性**辅助安装 opencode 到远程目标**（bootstrap），或完全可信的临时环境。
>
> **请谨慎使用**：生产 / 重要主机请使用 SSH key + 正常审批流程，不要暴露密码直连。

## 权限管控

```text
term_cli exec(command)
  ├─ 命中 DENY 黑名单（rm -rf / shutdown reboot mkfs 等） → 直接拒绝
  ├─ 命中只读白名单 且 无 shell 元字符 → 直接放行
  └─ 其他 → context.ask() 用户审批（:allow / :deny / :always）
```

- 只读白名单：`ls|cd|cat|grep|tail|head|ps|df|free|pwd|env|echo|curl|wget|git status|whoami|hostname|date|uname|uptime`
- 命令含 `;` `&&` `|` `$()` 等 shell 元字符 → 降级走 ask（防拼接绕过）
- 高危命令不进 ask 直接拒，`term_cli connect` 也走审批

## HTTP 终端查看

服务默认开启（配置 `server.enabled`）。`term_cli status` / `term_cli read`（history 模式）会返回实际地址（端口 0 时自动分配，避免冲突）：

```
浏览器访问 http://127.0.0.1:<port> 查看终端记录（WebSocket 实时推送）
```

页面按会话/终端切换，transcript 展示「命令 + 输出」历史对，raw 展示 xterm.js 实时画面。底部命令框提交命令；交互式程序（sudo 密码、REPL 等）需要逐键输入时，点终端区域或入口按钮切到**直接输入**（见「特性」），按键实时发往终端。

**传输任务浮窗**（header 的“传输任务”按钮开关，默认关闭（开关状态本地记忆）；固定右下角、最大高度约 50vh，列表内滚动，不参与终端/命令框布局，底部留出命令框空间）：展示**当前选中终端**（会话 + 终端名）的传输任务，每行含方向（上传/下载）、终端名、本地↔远端路径、状态（running/done/failed）、已传/总字节、耗时（失败时附错误码）。进度条按 `bytes/total` 显示，`total=0` 的 running 为不确定态。浮窗可关闭，关闭后 header 按钮仍保留任务计数，点击可重新打开；切换终端时列表随之切换（只看该终端任务），切换会话按新会话/终端快照刷新，任务更新时照常刷新。面板只读元数据，不显示文件内容；任务由工具上报；done/failed 保留 10 分钟、running 10 分钟无更新清理。

## 架构

```
opencode（插件进程）
  ├─ agent：每会话多个命名终端，PTY 固定 120×40
  │    ├─ SSH（ssh2 PTY shell）/ 本地·容器（Bun.Terminal）
  │    └─ 执行命令（支持长命令、中断与完成检测）
  ├─ server：独立 HTTP 子进程（WS 统一事件流，proto 版本校验）
  └─ web：transcript（消息对）/ raw（xterm.js）双视图，浏览器实时查看
```

## 开发

```bash
npm install      # 安装依赖（dependencies + devDependencies）
npm run build    # tsc（src → dist）+ node web/build.mjs（打包 Web 资源）
npm test         # 构建后跑 node:test 单测（cli-args + payload + transfer + transfer-events + server-transfer + shell-adapter + precheck + session-precheck）
```

- TS 源码在 `src/`，编译产物 `dist/`
- **`SERVER_PROTO_VERSION`**（`src/constants.ts`）：独立 HTTP 服务的代码/协议版本，server 启动写入 `server.json` 的 `proto` 字段，`ensureServer` 发现不符即杀旧进程重启。**改动服务端注入的页面模板（`web/src/index.html`）或 i18n 文案后必须递增该值**——否则常驻旧 server 注入的 `__I18N__`/占位符会与新版前端不一致，页面渲染出 `undefined`（旧注入 + 新前端）
- 本地测试：编译产物挂载到测试项目 `.opencode/` 文件夹，在该项目启动 opencode 验证
- 日志：`@xiaoqiong0v0/opencode-plugin-logger` 按天滚动落盘

## 发布

```bash
npm run build
npm publish      # 发布 dist/ + README.md（见 package.json 的 files）
```

本项目提交 GitHub 发布 npm；使用方 `opencode.json` 的 `plugin` 数组引用。

## 测试清单

需真实 SSH 主机，测试环境需自备 Docker/SSH（测试脚本不随仓库发布）：

- [ ] `term_cli connect` → 登录成功，cwd 为登录目录
- [ ] `term_cli exec("ls")` 连续多次，确认永不重连（同一会话）
- [ ] `term_cli exec("cd /var/log && pwd")` 后 `term_cli exec("pwd")` = `/var/log`（目录保持）
- [ ] 交互场景：`term_cli exec("sudo ...")` 触发密码提示 → `term_cli read` 配合
- [ ] 白名单命令不弹审批直接执行；`rm -rf` 被拒绝
- [ ] 白名单外命令弹 `context.ask()`，`:deny` 拒绝 / `:allow` 放行
- [ ] SSH 远程 `pwsh`：`term_cli exec("if then")` 发送前被拦截（未写入终端）；合法命令正常执行；远程未安装 `pwsh` 时回落 `powershell` 或放行（不误拦）
- [ ] SSH 远程 `cmd`：预检明确跳过，命令照常执行
- [ ] 长命令：`term_cli exec("sleep 60")` 超 5s 动画窗口转后台 watch，等待其完成（不设超时、不挂死会话），`Ctrl-C` 可中断，结果从 history 可读
- [ ] `term_cli read` 取前/后 N 条历史输出（含 `--includeCommand`、`source=buffer`）；运行中默认 read 返回当前快照（重复读取不消失），显式 `-s buffer` 读实时 buffer
- [ ] `term_cli upload ./a.txt ~/a.txt` 成功；重复执行（无 `--overwrite`）报目标已存在；加 `--overwrite` 覆盖；父目录不存在时加 `--mkdir` 成功
- [ ] `term_cli download ~/a.txt ./a.txt` 成功且字节一致；目录/符号链接被拒绝；`term_cli local ...` 会话上传/下载返回“仅支持 SSH 会话”
- [ ] `term_cli status` / HTTP 页面浏览器可访问
- [ ] `term_cli disconnect` 后连接释放

## 文档

- `docs/requirements/需求说明.md` — 原始需求
- `docs/design/方案分析.md` — 技术分析、决策、风险
- `docs/design/结构设计.md` — 编码依据
- `docs/design/消息协议重构设计.md` — WS 统一事件流协议（历史设计，当前以结构设计/代码为准）
- `docs/design/终端渲染与尺寸固定说明.md` — 终端尺寸固定、续行检测、渲染修复
- `docs/design/多语言配置说明.md` — toolLang / webLang 分离与边界
- `docs/design/多行命令包组与raw渲染修复说明.md` — 多行包组、raw 渲染、headless 屏幕、语法错误收尾
- `docs/design/中断探针修复说明.md` — Ctrl-C 中断探针（历史记录，当前行为以 README / 结构设计为准）
- `docs/design/直接输入与保活心跳说明.md` — 直接输入（焦点驱动）与 SSH/WS 保活心跳
- `docs/ASYNC.md` — 异步/并发交互点清单（含 SFTP 传输串行化、超时与清理契约）


