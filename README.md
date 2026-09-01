# opencode-ssh-tool

opencode 插件：让 opencode 像人一样操作**长驻交互式 SSH 会话**。连接一次，后续在一个会话里连续执行命令，保留当前目录、环境变量、交互状态；远程命令执行同样受 opencode 权限系统管控（类似内置 Bash 工具的审批）。

## 特性

- **长驻会话**：`ssh_connect` 建立连接后，`ssh_exec` 在同一会话执行命令，保留 cwd/环境/后台进程/sudo 缓存
- **PTY 交互**：分配伪终端，可处理 sudo 密码、vi、top 等交互程序
- **权限管控**：只读白名单直接放行、危险命令黑名单硬拒、其余走 `context.ask()` 用户审批
- **命令完成判定**：哨兵标记 + 静默窗口 + 超时三重兜底，动画输出（进度条等）自动识别
- **历史消息对**：命令+输出 按对数保留（默认 100 对），单条超大落盘文件
- **HTTP 终端查看**：默认开启本地服务，浏览器打开可滚动、自动刷新的终端记录页面
- **多语言**：工具描述默认英文，`SSH_TOOL_LANG=zh` 切中文

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
| `ssh_connect` | `host`, `user`, `port?` | 建立长驻 SSH 连接 + 打开 PTY shell |
| `ssh_exec` | `command` | 在**同一会话**执行命令，保留 cwd/环境 |
| `ssh_read` | `lines?` | 读取未消费缓冲输出（交互/轮询场景） |
| `ssh_status` | — | 检查命令是否仍在执行（busy）、缓冲量、连接状态 |
| `ssh_server` | — | 查询本地 HTTP 服务地址/端口/会话数 |
| `ssh_terminal` | `direction?`, `limit?`, `includeCommand?` | 取前/后 N 条历史输出；返回浏览器查看地址 |
| `ssh_disconnect` | — | 关闭连接，清理会话态 |

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
  // 会话记录（命令+输出 消息对）管理
  "history": {
    // 保留的消息对数上限（默认 100，最小 1）。超出时移除最旧的一对
    "maxMessages": 100,
    // 单条命令+输出超过此字节数时写入文件（默认 3145728 = 3MB），内存只存引用
    "spillThreshold": 3145728
  }
}
```

## 认证

按优先级自动选择，认证信息**不硬编码**、不落日志：

1. **SSH key**（推荐）：用户默认私钥（`id_ed25519` / `id_rsa`）
2. **SSH agent**：agent socket / Windows OpenSSH agent
3. **环境变量密码**：`SSH_PASS_<HOST大写>` 优先，回退 `SSH_PASSWORD`

## 权限管控

```text
ssh_exec(command)
  ├─ 命中 DENY 黑名单（rm -rf / shutdown reboot mkfs 等） → 直接拒绝
  ├─ 命中只读白名单 且 无 shell 元字符 → 直接放行
  └─ 其他 → context.ask() 用户审批（:allow / :deny / :always）
```

- 只读白名单：`ls|cd|cat|grep|tail|head|ps|df|free|pwd|env|echo|curl|wget|git status|whoami|hostname|date|uname|uptime`
- 命令含 `;` `&&` `|` `$()` 等 shell 元字符 → 降级走 ask（防拼接绕过）
- 高危命令不进 ask 直接拒，`ssh_connect` 也走审批

## HTTP 终端查看

服务默认开启（配置 `server.enabled`）。`ssh_server` / `ssh_terminal` 会返回实际地址（端口 0 时自动分配，避免冲突）：

```
浏览器访问 http://127.0.0.1:<port> 查看可滚动、每 2s 自动刷新的终端记录
```

页面按会话切换，展示「命令 + 输出」历史对。

## 架构

```
opencode（插件进程）
  ├─ ssh2 客户端：长驻连接 + PTY shell（每个 opencode 会话一个）
  │    └─ 哨兵法执行命令（combo; echo __SSH_DONE_<rand>__）
  ├─ SessionHistory：命令+输出 消息对（按对数限制，超大落盘）
  └─ HTTP 服务：127.0.0.1 随机端口，浏览器查看终端记录
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

- [ ] `ssh_connect` → 登录成功，cwd 为登录目录
- [ ] `ssh_exec("ls")` 连续多次，确认永不重连（同一会话）
- [ ] `ssh_exec("cd /var/log && pwd")` 后 `ssh_exec("pwd")` = `/var/log`（目录保持）
- [ ] 交互场景：`ssh_exec("sudo ...")` 触发密码提示 → `ssh_read` 配合
- [ ] 白名单命令不弹审批直接执行；`rm -rf` 被拒绝
- [ ] 白名单外命令弹 `context.ask()`，`:deny` 拒绝 / `:allow` 放行
- [ ] 长命令超时：`ssh_exec("sleep 60")` 30s 超时返回，不挂死会话
- [ ] `ssh_terminal` 取最后/前 N 条输出（含 `includeCommand`）
- [ ] `ssh_server` / HTTP 页面浏览器可访问
- [ ] `ssh_disconnect` 后连接释放

## 文档

- `docs/requirements/需求说明.md` — 原始需求
- `docs/design/方案分析.md` — 技术分析、决策、风险
- `docs/design/结构设计.md` — 编码依据
