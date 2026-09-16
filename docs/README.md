# opencode-ssh-tool 文档索引

opencode **npm 插件**（本项目提交 GitHub）：长驻交互式 SSH 会话工具，远程命令受 opencode 权限管控。

## 文档结构

| 文档 | 说明 |
|---|---|
| [requirements/需求说明.md](requirements/需求说明.md) | 原始需求（**不可更改**） |
| [design/方案分析.md](design/方案分析.md) | 技术分析、关键决策、风险清单 |
| [design/结构设计.md](design/结构设计.md) | 编码依据（结构定义） |
| [design/消息协议重构设计.md](design/消息协议重构设计.md) | WS 实时消息协议重构（统一事件流）设计说明与全路径清单 |

## 变更说明

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-08-31 | 建立需求/分析/结构文档 | 方案评审与编码前置 |
| 2026-09-07 | OSC 不可见标记法替换哨兵法 | 哨兵注入文本泄露、跨 shell 不可靠 |
| 2026-09-07 | Shell 探测 + 共享 logger + Web 删除终端 | 支持 pwsh/bash/zsh，多语言，调试模式 |
| 2026-09-15 | WS 协议重构为统一事件流（`cmdStart/out/cmdDone` + `diff`，deprecate `stream/done/run/runEnd/cmdStart(web向)/setRaw`） | 消除每条命令后的全量 snapshot 重复推送、`busy:false` 重复广播、`runEnd` 冗余；server 只认 agent 上报（删同进程直连死代码）；`_txPos` 游标替代 `_bufPos/+_rawPos`；`setMode` 替代 `setRaw`；`SERVER_PROTO_VERSION` 2。详见 `设计/消息协议重构设计.md` |
