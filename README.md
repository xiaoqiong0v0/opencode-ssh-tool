# opencode-ssh-tool

opencode 插件：让 opencode 像人一样操作**长驻交互式终端会话**——远程 SSH（ssh2 PTY）与本地/容器（Bun.Terminal，如 `pwsh`、`docker exec -it`）。连接一次，后续在会话里连续执行命令，保留当前目录、环境变量、交互状态；命令执行同样受 opencode 权限系统管控（类似内置 Bash 工具的审批）。

## 特性

- **长驻会话**：`term_cli connect` 建立连接后，`term_cli exec` 在同一会话执行命令，保留 cwd/环境/后台进程/sudo 缓存
- **PTY 交互**：分配伪终端，可处理 sudo 密码、vi、top 等交互程序
- **权限管控**：只读白名单直接放行、危险命令黑名单硬拒、其余走 `context.ask()` 用户审批
- **命令完成判定**：完成标记法（`<SSH_DONE:seq:退出码>`）+ 静默窗口 + 动画检测（进度条等长输出自动识别）三重判定；**断连兜底，不设超时强杀**（长命令由 Ctrl-C 干预）；未闭合引号/反引号等会触发 shell 续行的命令提交前拦截
- **双视图**：transcript（命令+输出消息对）与 raw（xterm.js 实时画面，支持 vi/top 等全屏程序）；终端尺寸前后端一致固定 `120×40`
- **历史消息对**：命令+输出 全部存文件（`~/.opencode/plugins-cache/opencode-ssh-tool/<会话>/`），按对数保留（默认 100 对），重启不丢、会话关闭清理
- **HTTP 终端查看**：默认开启本地服务，浏览器打开可查看终端记录（WebSocket 实时推送，无轮询）
- **多语言**：`toolLang`（工具描述/CLI/session 文案）与 `webLang`（页面 UI）独立配置，默认英文；环境变量 `SSH_TOOL_LANG` / `SSH_WEB_LANG` 分别覆盖

## 安装

```jsonc
// opencode.json
{
  "plugin": ["opencode-ssh-tool"]
}
```

发布到 npm 后通过 `plugin` 数组引用；或本地调试时挂载到项目 `.opencode/` 文件夹。

## 工具

| 工具 | 入参 | 行为 |
|---|---|---|
| `term_cli` | `args`（完整命令行字符串） | **CLI 风格单工具**：SSH / 本地 / 容器终端会话。子命令：`connect` / `local` / `exec` / `read` / `send` / `status` / `disconnect` / `help`；用 `help` 查看完整用法 |

```text
term_cli connect root@host:22 [-n name] [-p password|file:path]   # SSH 连接
term_cli local "pwsh|docker exec -it <容器> sh" [-n name] [-c cwd] # 本地/容器终端
term_cli exec "<command>" [-n name] [-w]                          # 执行命令（默认提交后立即返回；-w 等到命令真正结束，仅用于预期很快结束的命令）
term_cli read [-n name] [-s buffer|history] [-l limit] [--head]   # 读输出
term_cli send "<text>" [-n name]                                  # 发送按键（sudo 密码等）
term_cli status [-n name]                                         # 状态
term_cli disconnect [-n name]                                     # 断开
term_cli help                                                     # 完整用法
```

> 一个 opencode 会话可创建**多个命名终端**（如 `db`、`web`、`prod`），用不同 `name` 并行维护；同名重复创建会先关闭旧的。工具只暴露一个 `args` 字符串参数，模型像敲命令行一样调用，`help` 引导其学会所有用法（单工具多命令模式，省 token）。

## 配置

配置文件 `~/.config/opencode/ssh-tool.jsonc`（首次运行自动生成）：

```jsonc
{
  // HTTP 终端记录服务开关（默认 true）
  "server": {
    "enabled": true,
    // 端口：不设默认值。0 = 自动分配随机端口（推荐，避免冲突）；可显式指定，如 8137
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

页面按会话/终端切换，transcript 展示「命令 + 输出」历史对，raw 展示 xterm.js 实时画面。

## 架构

```
opencode（插件进程）
  ├─ agent：每会话多个命名终端，PTY 固定 120×40
  │    ├─ SSH（ssh2 PTY shell）/ 本地·容器（Bun.Terminal）
  │    └─ 完成标记法执行命令（`command ;markerCmd` → `<SSH_DONE:seq:退出码>`）
  ├─ server：独立 HTTP 子进程（WS 统一事件流，proto 版本校验）
  └─ web：transcript（消息对）/ raw（xterm.js）双视图，浏览器实时查看
```

## 开发

```bash
npm install      # 安装依赖（dependencies + devDependencies）
npm run build    # tsc：src → dist
```

- TS 源码在 `src/`，编译产物 `dist/`
- 本地测试：编译产物挂载到测试项目 `.opencode/` 文件夹，在该项目启动 opencode 验证
- 日志：`@xiaoqiong0v0/opencode-plugin-logger` 按天滚动落盘

## 发布

```bash
npm run build
npm publish      # 只发布 dist/
```

本项目提交 GitHub 发布 npm；使用方 `opencode.json` 的 `plugin` 数组引用。

## 测试清单

需真实 SSH 主机（可用 Docker 测试环境，见 `.tmp/ssh-test-docker.ps1`）：

- [ ] `term_cli connect` → 登录成功，cwd 为登录目录
- [ ] `term_cli exec("ls")` 连续多次，确认永不重连（同一会话）
- [ ] `term_cli exec("cd /var/log && pwd")` 后 `term_cli exec("pwd")` = `/var/log`（目录保持）
- [ ] 交互场景：`term_cli exec("sudo ...")` 触发密码提示 → `term_cli read` 配合
- [ ] 白名单命令不弹审批直接执行；`rm -rf` 被拒绝
- [ ] 白名单外命令弹 `context.ask()`，`:deny` 拒绝 / `:allow` 放行
- [ ] 长命令：`term_cli exec("sleep 60")` 超 5s 动画窗口转后台 watch，等待其完成（不设超时、不挂死会话），`Ctrl-C` 可中断，结果从 history 可读
- [ ] `term_cli read` 取前/后 N 条历史输出（含 `includeCommand`、`source=buffer`）
- [ ] `term_cli status` / HTTP 页面浏览器可访问
- [ ] `term_cli disconnect` 后连接释放

## 文档

- `docs/requirements/需求说明.md` — 原始需求
- `docs/design/方案分析.md` — 技术分析、决策、风险
- `docs/design/结构设计.md` — 编码依据
- `docs/design/消息协议重构设计.md` — WS 统一事件流协议
- `docs/design/终端渲染与尺寸固定说明.md` — 终端尺寸固定、续行检测、渲染修复


