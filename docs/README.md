# opencode-ssh-tool 文档索引

opencode **npm 插件**（本项目提交 GitHub）：长驻交互式 SSH 会话工具，远程命令受 opencode 权限管控。

## 文档结构

| 文档 | 说明 |
|---|---|
| [requirements/需求说明.md](requirements/需求说明.md) | 原始需求（**不可更改**） |
| [design/方案分析.md](design/方案分析.md) | 技术分析、关键决策、风险清单 |
| [design/结构设计.md](design/结构设计.md) | 编码依据（结构定义） |
| [design/消息协议重构设计.md](design/消息协议重构设计.md) | WS 实时消息协议重构（统一事件流）设计说明与全路径清单 |
| [design/终端渲染与尺寸固定说明.md](design/终端渲染与尺寸固定说明.md) | 终端尺寸固定 120×40、取消 resize、shell 续行检测、raw/transcript 渲染修复 |
| [design/多语言配置说明.md](design/多语言配置说明.md) | toolLang / webLang 分离与边界（web 只管页面 UI），agent/session 文案 i18n |
| [design/多行命令包组与raw渲染修复说明.md](design/多行命令包组与raw渲染修复说明.md) | 多行命令统一 shell 组包组（删除多行拆分）、离线 raw 阶梯修复、ConPTY 行分隔符 `\r`（与匹配形式解耦）、续行/完整性检测修正、服务锁陈旧自愈；取代 G10 拆分做法 |

## 变更说明

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-08-31 | 建立需求/分析/结构文档 | 方案评审与编码前置 |
| 2026-09-07 | OSC 不可见标记法替换哨兵法 | 哨兵注入文本泄露、跨 shell 不可靠 |
| 2026-09-07 | Shell 探测 + 共享 logger + Web 删除终端 | 支持 pwsh/bash/zsh，多语言，调试模式 |
| 2026-09-15 | WS 协议重构为统一事件流（`cmdStart/out/cmdDone` + `diff`，deprecate `stream/done/run/runEnd/cmdStart(web向)/setRaw`） | 消除每条命令后的全量 snapshot 重复推送、`busy:false` 重复广播、`runEnd` 冗余；server 只认 agent 上报（删同进程直连死代码）；`_txPos` 游标替代 `_bufPos/+_rawPos`；`setMode` 替代 `setRaw`；`SERVER_PROTO_VERSION` 2。详见 `design/消息协议重构设计.md` |
| 2026-09-18 | REPL 增量丢失、错误命令输出裁剪、pwsh 完成标记顺序修复 | `exec` 分支误清空 streamBuf；`extractOutputStart` 全局最后匹配被裸命令回显带偏；`Write-Host` 抢在格式化输出前 |
| 2026-09-18 | 终端尺寸固定 `120×40`、取消 resize 通道、shell 续行检测、toBottom 移入 header、zsh 标记补尾换行 | PTY 与 xterm 行数不一致致 PSReadLine 绝对定位越界（raw 错位）；resize 通道在多浏览器/历史重开下冲突；未闭合引号/反引号使 shell 续行等待 → 完成标记失效卡死；toBottom 悬浮遮挡；zsh 标记输出缺尾换行触发 `PROMPT_EOL_MARK`（`#`）。`SERVER_PROTO_VERSION` 11。详见 `design/终端渲染与尺寸固定说明.md` |
| 2026-09-18 | 语言配置恢复 `toolLang` / `webLang` 分离；agent/session 文案接入 i18n | `12ab9bc` 误将两类语言合并为单一 `lang`（`webLang` 只应管页面 UI）；session 级提示（busy/续行/探测超时/未连接）硬编码、且探测超时文案中文硬编码。新增 `SSH_WEB_LANG`。详见 `design/多语言配置说明.md` |
| 2026-09-22 | 多行命令统一包组（删除 heredoc/续行感知拆分）；离线 raw 阶梯修复；ConPTY 行分隔符；续行/完整性检测修正；服务锁陈旧自愈 | shell 逐行执行致回显/输出交错、transcript 丢中间输出；历史 `command` 为裸 `\n`，xterm 只下移不复位；ConPTY 裸 `\n` 不提交行；删除拆分后 `hasOpenContinuation` 判错会拒合法命令/发卡死命令（注释/heredoc 闭合/括号深度/here-string/cmd 引号共 9 处修正，矩阵 81 断言全 PASS）；崩溃残留 `server.lock` 使服务再也起不来。`stmtSep` 顺带修复 cmd 完成标记从未生效。`SERVER_PROTO_VERSION` 13。详见 `design/多行命令包组与raw渲染修复说明.md` |
