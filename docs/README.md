# opencode-ssh-tool 文档索引

opencode **npm 插件**（本项目提交 GitHub）：长驻交互式 SSH 会话工具，远程命令受 opencode 权限管控。

## 文档结构

| 文档 | 说明 |
|---|---|
| [requirements/需求说明.md](requirements/需求说明.md) | 原始需求（**不可更改**） |
| [design/方案分析.md](design/方案分析.md) | 技术分析、关键决策、风险清单（历史方案） |
| [design/结构设计.md](design/结构设计.md) | 编码依据（结构定义） |
| [design/消息协议重构设计.md](design/消息协议重构设计.md) | WS 实时消息协议重构（统一事件流）设计说明与全路径清单（历史设计） |
| [design/终端渲染与尺寸固定说明.md](design/终端渲染与尺寸固定说明.md) | 终端尺寸固定 120×40、取消 resize、shell 续行检测、raw/transcript 渲染修复 |
| [design/多语言配置说明.md](design/多语言配置说明.md) | toolLang / webLang 分离与边界（web 只管页面 UI），agent/session 文案 i18n |
| [design/多行命令包组与raw渲染修复说明.md](design/多行命令包组与raw渲染修复说明.md) | 多行命令统一 shell 组包组（删除多行拆分）、离线 raw 阶梯修复、ConPTY 行分隔符 `\r`（与匹配形式解耦）、续行/完整性检测修正、服务锁陈旧自愈；transcript 与模型文本改用 `@xterm/headless`（§11）、shell 语法/解析错误作为完成信号（§12）；取代 G10 拆分做法 |
| [design/中断探针修复说明.md](design/中断探针修复说明.md) | Ctrl-C 中断收尾：写完 `\x03` **立即**补发中断探针（当前 seq 的 `SSH_PROBE` 标记（nonce+seq）），之后按 `interruptProbeInterval`（秒，默认 5）周期补发；完成判定只认标记（`^C` 回显不再作完成依据）、seq 限定与迟到探针回显剔除；定时器不判完成。**历史修复记录，当前行为以 README / 结构设计为准** |
| [design/直接输入与保活心跳说明.md](design/直接输入与保活心跳说明.md) | Web「直接输入」焦点驱动（默认命令框优先、keystroke 通道、不持久化、离线不可点）；SSH 协议级保活（`keepalive@openssh.com`，带外不写 PTY）与 WS 应用层心跳（ping/pong、半开自愈）；`SERVER_PROTO_VERSION` 注入内容改动须递增 |

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
| 2026-09-29 | 多行命令行分隔符按**探测到的 shell 类型/平台**判定（`ShellAdapter.windowsShell`：Windows shell pwsh/cmd 与本地 ConPTY 会话写入用 `\r`，SSH + POSIX 用 `\n`；`_composeCommand` = `windowsShell ? "\r" : _lineSep`，与匹配形式解耦；**当时实现**，2026-10-22 起运行时判据改为 `_windowsPTY` + `_ptyLineSep()`） | 修 SSH 连 Windows pwsh/cmd 时多行命令**逆序发送并卡在续行**：ConPTY 下裸 `\n` 只下移不复位列、不提交行 → 多行逆序 + 卡 `>>`；实测 `\r` 正常。详见 `design/多行命令包组与raw渲染修复说明.md` §4 |
| 2026-09-29 | transcript 与模型文本改用 `@xterm/headless`（删除自研 `simulateScreen` / `TermScreen`，新增 web `HeadlessScreen`） | 自研屏幕模拟器缺**滚动**语义：CUP 回到屏幕底行时原地覆盖，raw 中的多行错误块在模型侧只剩最后一行（实测 1 行 31 字符）。两侧同 `cols/rows/scrollback`（新增 `TERM_SCROLLBACK_LINES = 2000`）+ `allowProposedApi: true`；颜色按 palette 0-15 / 256 色 / `#rrggbb` 重建；`toModelText` 因异步 write 改返回 `Promise<string>`。真实缓存字节回归：错误块两行都在。详见 `design/多行命令包组与raw渲染修复说明.md` §11 |
| 2026-09-29 | shell 语法/解析错误作为完成信号（新增 `src/ansi.ts`、`syntaxErrorRe` / `detectSyntaxError`、`SYNTAX_QUIET_MS` / `SYNTAX_MAX_WAIT_MS`） | pwsh `ParserError` 使**整行作废**，同行拼装的完成标记永不执行 → 等不到完成、一直 busy、输出不落地（实测只能 Ctrl-C）。检测**先剥 ANSI 再按行首判定**（真实 ConPTY 错误块前有 `\x1b[?25l` / `\x1b[39;1H` 等非 SGR 序列，只容忍 SGR 的首版因此失效）；命中后等输出安静再收尾，`exitCode = null`、窗口取到缓冲区末尾、回显改首次匹配。cmd 不识别（`null`）。单测 74 例 PASS、回归 81/81 + 9/9、真机 pwsh over SSH 实测。详见 `design/多行命令包组与raw渲染修复说明.md` §12 |
| 2026-10-01 | 服务启动**不再阻塞插件加载**（**v0.6.4** `f92169c`/`71a3209`）：插件工厂不 `await ensureServer`，改为发起即返回（保存 Promise 并兜底 catch），需要服务 URL 的路径（`doRead`/`doStatus` 等）惰性等待，服务不可用时给明确提示、不抛错；**固定端口绑定失败直接放弃，不回退不重试**（新增 `net.createServer` 绑定预检 + 子进程启动即退出检测，失败按端口级 Promise 缓存收敛为一次结果、日志仅 1 行）；未配置端口（0）仍由 OS 自动分配并记入 `server.json`，同进程复用已起服务不重复 spawn | 原先工厂 `await ensureServer` 最坏卡约 20s 阻塞 opencode 启动（实测改为 18-22ms 返回）；固定端口冲突时每 16-19 秒刷屏重试。服务唯一、不允许重复实例。背景：用户配置端口 49263 落在 Windows 保留区间 49252-49351（Hyper-V/WSL 动态保留）导致 `listen EACCES` |
| 2026-10-04 | 本地/容器会话（**v0.6.5**）改用**内联 `terminal:{...}`** 创建，句柄从 `proc.terminal` 取（不再 `new Bun.Terminal` 后把对象传给 `spawn`） | Bun v1.3.14 对已创建的 `Terminal` 对象不向子进程传 `pty_slave_fd` → 子进程不 `setsid+TIOCSCTTY`，控制终端仍是 opencode TUI 的 pts → `sudo` 读 `/dev/tty` 抢占 TUI。详见 `src/local-session.ts` 注释与 `src/bun.d.ts` 警示 |
| 2026-10-04 | 后台 watch 去掉 10 分钟绝对寿命看门狗（`MAX_WATCH_LEN`，**v0.6.6**），收尾条件改为**仅断连**（`!this._connected`） | 原看门狗把运行满 10 min 的命令强制当结束：`busy:false`、清 running 上下文、停 watch、**不写 history**（误报、transcript 停更）；长命令改由 Ctrl-C 干预。详见 `design/消息协议重构设计.md` D4/D5 |
| 2026-10-08 | Ctrl-C 中断改用**中断探针**收尾（`SERVER_PROTO_VERSION` 不变）：`send()` 命中 `\x03` 后补发当前 seq 裸标记命令；删除 `^C` 回显完成判定（`_waitCompletion`/`_startBackgroundWatch`）；新增 `_probeSeqs` + `_stripProbeEchoes` 剔除迟到探针回显、`getRunningStream`/`readBuffer` 同步剔除；定时器仅周期补发探针、不判完成 | 前台命令 Ctrl-C 后命令列表被丢弃、原标记不执行 → busy 卡死、`exec` 无限等待；且捕获/忽略 SIGINT 的程序回显 `^C` 但未结束，旧路径假完成会把后续命令喂进运行中程序。详见 `design/中断探针修复说明.md` |
| 2026-10-09 | 中断探针改为**写完 `\x03` 立即补发首条**，之后按配置间隔周期补发（新增配置项 `interruptProbeInterval`，单位秒、默认 5、非法值回退默认；`INTERRUPT_PROBE_INTERVAL_DEFAULT_SEC` 替代 `INTERRUPT_PROBE_DELAY_MS`；`index.ts` 转毫秒传入 `BaseSession` 构造器） | 首次探针从"等 2s"提前到"立即"以尽快触发被中断命令收尾；补发节奏可配置（5s 降低无谓重发）；定时器仍只补发、完成只认当前 seq 标记。详见 `design/中断探针修复说明.md` |
| 2026-10-16 → 10-22 | **v0.6.15**（`cf77210` / `92f4c1a`）：发送前语法预检（新增 `validateCommand` + pwsh 侧车，抽到 `src/precheck.ts`，`term_exec` 与 web `run-exec` 共用；命中失败不写终端，SSH 不预检）；语法错误改**安静收尾**、不再补发探针；修注释剥离（`stripCommandTail` 跨行引号 / `; #` 等注释）与 cmd marker 独行 + `^<^>` 转义 | 预检把语法错误挡在写入终端之前（整行作废会使同行标记永不执行 → busy 卡死）；不补探针避免写进仍在运行的程序 stdin；注释剥离 / 转义修正避免误伤合法命令与 cmd 特殊字符 |
| 2026-10-22 | **v0.6.16**（`961d4c1`）：跨平台行分隔符（`_windowsPTY` / `_ptyLineSep()`，SSH pwsh 按 `$PSHOME` 路径判定 ConPTY；Windows 本地优先真实 pwsh.exe、否则回退 powershell 5.1）；history-only（无 state 文件）立即允许删除；标题持久化到 `cacheRoot/<sid>/meta.json`；`.log-dedup` 7 天清理；`SERVER_PROTO_VERSION = 19` | 统一 ConPTY/Unix PTY 提交分隔符，避免 SSH→Windows pwsh 多行逆序；历史会话只剩 history 时不应再等陈旧窗口才能删；state 文件清理后仍能显示会话标题；去重标记文件长期累积需清理；服务端协议/注入内容变更须提升 proto |
| 2026-10-23 | **v0.6.17**：文档与实现对齐（完成判定/中断探针/跨平台分隔符/预检边界/构建发布/历史设计标注）；`term_cli help` 的 `read` 参数统一为 `--includeCommand` | 修正过期或错误陈述，避免用户照文档/帮助操作时报 `Unknown option`；历史设计保留原方案但明确标注“当时值/历史设计” |
