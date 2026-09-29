# 多行命令包组与 raw 渲染修复说明

> 本文件为变更说明文档，记录七项改动：多行命令统一包组（删除多行拆分）、离线会话 raw 阶梯错位修复、
> 多行命令写入行分隔符按探测到的 shell 类型/平台修复（ConPTY 用 `\r`，含 SSH→Windows pwsh/cmd）、
> 续行/完整性检测修正、服务锁陈旧自愈、transcript 与模型文本改用 `@xterm/headless`（§11）、
> shell 语法/解析错误作为完成信号（§12）。§2–§6 为前序批次，§11 / §12 为后续追加批次。
> 基线文档 `结构设计.md` / `方案分析.md` 按本文件回填；`终端渲染与尺寸固定说明.md` 的 **G10「heredoc 感知拆分」做法已被本文件 §2 取代**（详见 §9）。

## 1. 背景

三条同类问题，根因都指向「多行命令被当作多行分别执行/渲染」：

| 场景 | 问题 |
|---|---|
| SSH 会话执行普通多行命令 | shell 逐行执行，回显与输出交错，transcript 只剩最后一段输出 |
| 重启后查看历史（离线）会话 raw | 多行命令逐行阶梯错位 |
| 本地/容器会话（Windows ConPTY）执行多行命令 | 行序错乱、停在 `>>` 续行、随后被中断 |

另有一项独立的基础设施缺陷：服务进程异常退出后残留锁目录，导致服务再也无法启动（§6）。

## 2. 多行命令统一包组，删除多行拆分

### 现象

普通多行命令原先直接以 `body ;marker` 整段发送，shell **逐行执行**，回显与输出交错；
`extractOutputStart` 只能锚到最后一行 → transcript 丢掉中间输出。

实测 `cd /tmp` + `echo AAA` + `echo BBB` + `pwd`（一次提交）：history 只记到 `/tmp`，`AAA` / `BBB` 丢失。

### 根因

一次提交的多行文本在 PTY 层面等价于「用户按了多次回车」，除非把它变成**一条**命令，否则回显与输出必然交错，
事后按文本定位无法还原中间输出。旧的「按续行/heredoc 感知拆成多条逐条执行」是绕开问题的做法，拆分规则难以穷举（heredoc、行尾续行符、嵌套引号）且每拆一条就多一次回显/输出交错。

### 修复

`BaseSession._composeEchoText`（`src/base-session.ts`）：命令体**含多行**（有 `\n`）时用 shell 组语法包成**一条**命令
（一次输入 = 一条命令 = 一段输出），完成标记拼到组尾；单行命令仍为 `body <stmtSep><marker>`。

`src/shell-adapter.ts` 接口新增两个成员：

| 成员 | 说明 | 各 shell 取值 |
|---|---|---|
| `readonly stmtSep: string` | 语句分隔符（标记拼接用） | zsh / bash / pwsh：`;`；cmd：`&` |
| `groupWrap(body: string): string \| null` | 多行包组语法；返回 `null` 表示不包组 | zsh / bash：`` `{ ${body}\n}` ``；pwsh：`` `. { ${body}\n}` ``；cmd：`null` |

- **cmd 用 `&` 而非 `;`**：cmd 下 `;` 不是语句分隔符 → **顺带修复**了 cmd 完成标记此前实际从未生效的问题。
- **pwsh 必须点源（dot-source）`. { }`**：保留当前作用域。不可用 `& { }`——那是子作用域，会丢变量/状态。
  已实测：`. { $x=7; Set-Location /tmp }` 之后 `$x` 与 cwd 均保留；`& { }` 形式变量丢失。
- **cmd 不包组**：组内 `%errorlevel%` 是**解析期**展开，退出码会失真，故 `groupWrap` 返回 `null`，`_composeEchoText` 回退原样拼接。

### 删除（已不存在）

| 位置 | 删除内容 |
|---|---|
| `src/shell-adapter.ts` | `ShellAdapter.splitCommand`（接口声明 + 4 个适配器实现）、模块函数 `splitByContinuation`、`hasHeredoc` |
| `src/base-session.ts` | `BaseSession.splitCommand` |
| `src/agent.ts` | `AgentSession.splitCommand` 声明、`run-exec` 中的多行拆分分支 |

### 保留（勿误记为已删除）

| 项 | 位置 | 作用 |
|---|---|---|
| 命令队列 `execQueue` / `execQueued` | `src/base-session.ts` | 另一个入口：**忙时快速连续提交排队**（与多行拆分无关） |
| `cmdDone.more` / `hasMore()` | 协议 + `src/base-session.ts` | 排队序列的「还有后续」标记 |
| `seqHold` | `src/server.ts` | 排队序列期间保持 busy 状态 |
| `_holdBusy` / `setHoldBusy` | `src/base-session.ts` | 排队序列中间命令完成时不清 busy，busy 不闪 `false` |
| `hasOpenContinuation` | `src/shell-adapter.ts` | 续行检测：不完整命令仍**拒绝提交**；判定规则本轮后续修正（见 §5） |
| `splitCommand`（同名不同物） | `src/local-session.ts` | 命令行 → 参数数组（`Bun.spawn` 用），与被删除的多行拆分无关 |

## 3. 离线会话 raw 视图「阶梯错位」修复

### 现象

重启后查看历史（离线）会话的 raw 视图：多行命令每一行都从上一行结束的列继续，呈阶梯状。

### 根因

离线会话的 raw 由 `src/server.ts` 的 `buildRawFromHistory` 用历史消息对重建。
历史 `command` 字段存的是**原始命令文本**，换行是**裸 `\n`**（实测 `command` 无 `\r\n`，而 `output` 字段带 `\r\n`）。
xterm.js 里裸 `\n` 只下移一行、**不复位到行首** → 阶梯错位。

### 修复

`buildRawFromHistory` 的 **cmd 分支**改为规范化行尾：

```ts
p.text.replace(/\r?\n/g, "\r\n") + "\r\n"
```

out / run / sep 分支**不动**——输出是原始字节流，保持保真（其中本就带 `\r\n`）。

### 协议版本

`SERVER_PROTO_VERSION` **12 → 13**。server 代码变更须提升协议版本，`ensureServer` 才会替换旧 server 进程，否则改动不生效。

## 4. 多行命令行分隔符：按探测到的 shell 类型/平台（Windows ConPTY）

### 现象

本地 pwsh 会话里多行命令行序错乱、停在 `>>` 续行提示、随后被中断；
同一问题也出现在 **SSH 连到 Windows 上的 pwsh/cmd**（实测：多行命令逆序执行并卡在 `>>`）。

### 根因

**ConPTY 下裸 `\n` 不提交行**（需 `\r`）；而 **Unix PTY**（POSIX shell）下裸 `\n` 可以正常提交。已实测两者行为差异。
§2 包组后，组语法内部依赖换行真正提交行，ConPTY 场景下 `\n` 不提交 → 包组失效并错乱。

关键点：行分隔符取决于 **shell 运行在哪种控制台（ConPTY 还是 Unix PTY）**，即**按探测到的 shell 类型/平台**决定，
而**非按传输类型（本地 / SSH）**。初版把规则写成「本地 → `\r`、SSH → `\n`」，导致 **SSH→Windows pwsh/cmd 被判成 `\n`**
→ 与本地 ConPTY 一样不提交行 → 多行逆序卡死。

### 修复：匹配形式与写入形式解耦 + 按 shell 类型选写入分隔符

组合文本分两种形式，行分隔符改写**只发生在写入形式**：

| 成员 | 位置 | 职责 |
|---|---|---|
| `_composeEchoText(command)` | `src/base-session.ts` | **规范形式（恒 `\n` 分行、无尾部回车）**：包组 + 标记同行拼接；供 `extractOutputStart` 按 `\n` 切行、段间宽松匹配跳过 `>>` / `>` 续行提示。**不随 shell 类型改变**（匹配用） |
| `_composeCommand(command)` | `src/base-session.ts` | **写入 PTY 形式**：`const sep = this._adapter?.windowsShell ? "\r" : this._lineSep`，再 `_composeEchoText(...).replace(/\n/g, sep) + "\r"` |
| `ShellAdapter.windowsShell` | `src/shell-adapter.ts` | 该 shell 是否运行在 Windows 控制台（ConPTY）：pwsh / cmd → `true`（写入须 `\r`）；zsh / bash → `false`（`\n` 可正常提交） |
| `_lineSep` | `BaseSession` 默认 `"\n"` | **回退值**（无 `windowsShell` 判定时用）：SSH + POSIX 走 Unix PTY → `\n`；`src/local-session.ts` 覆盖为 `"\r"`（本地 ConPTY，adapter 尚未探测/为 null 时兜底） |

**行分隔符判定规则（最终）**：Windows shell（pwsh/cmd，ConPTY）→ `\r`；本地会话（ConPTY）→ `\r`；SSH + POSIX（Unix PTY）→ `\n`。

**为何必须解耦（实测）**：初版实现是在 `_composeEchoText` 返回前把 `\n` 替换为行分隔符——
`\r` 场景下组合文本不含任何 `\n`，`extractOutputStart` 按 `\n` 切行时整段成为一行，
段间宽松匹配失效 → **命令回显剥离失败**（本地 pwsh 多行命令的 history 里带着整段回显与会话残留噪音）。
解耦后实测：本地 pwsh 多行命令返回纯 `x=7 loc=D:\tmp`，history 记一条。

实测：本地 pwsh 用 `\r` 后行序正确、组内作用域保留、marker 正常。
实测（SSH→Windows pwsh）：用 `\n` 分隔时命令逆序卡死；改按 `windowsShell` 选 `\r` 后行序正确、组内作用域保留、输出正常。
脚本 `.tmp/check-winshell.mjs` 断言 15 项全 PASS（adapter 取值 + `_composeCommand` 分隔符）。

## 5. 续行/完整性检测修正

### 背景

删除多行拆分（§2）后，`hasOpenContinuation`（判「shell 是否会等待续行」）成为关键闸门：
**误判为不完整 → 合法命令被拒；漏判为完整 → 发出后 shell 等续行 → 会话卡死**。
实测矩阵发现 **7 处判错**（下表前 7 行），另有 **3 处边界误判**（引号内 `<<` 被误判 heredoc、`${x}#foo` 注释词首、pwsh here-string 起始不看引号，下表末 3 行），已一并修正。

### 修正清单

| 问题 | 表现 | 修法 |
|---|---|---|
| POSIX 不识别 `#` 注释 | `ls # don't` 被判未闭合 → **合法命令被拒** | 逐行扫描时词首 `#` 起跳至行尾（词首判定见「边界误判②」行，判定函数 `isPosixCommentStart`） |
| POSIX 不判 heredoc 是否闭合 | `cat <<'EOF'` 缺分隔符行 → 判完整 → 发出后 shell 等正文 → **卡死** | 扫描结束时 heredoc 分隔符仍未闭合 → 判不完整 |
| POSIX 不跟 `(`/`{` 深度 | 未闭合 `$(ls`、裸 `{` → 卡死 | 引号外跟踪 `()` / `{}` 深度，任一 **> 0** 判不完整（用「> 0」而非「≠ 0」，兼容 `case` 臂 `a)` 产生的负括号深度） |
| pwsh 不跟 `{}` / `()` 深度 | `if ($true) {`、`$x = (1 +` → 卡死 | 同上跟踪深度 |
| pwsh 不识别 here-string | `@"…` 未闭合 → 卡死 | 识别 `@"` / `'@` 起止（起始判定见「边界误判③」行），正文整行跳过，未闭合判不完整 |
| cmd 不跟 `()` 深度 | `( echo a` 未闭合（cmd 会 `More?`）→ 卡死 | 引号外跟踪 `()` 深度 |
| cmd 把 `"` 当续行 | `echo "unclosed` 被判未闭合 → **合法命令被拒** | 删除 cmd 的双引号续行判断（cmd 无此语义） |
| 边界误判①：`heredocDelim` 不看引号 | `echo "a << b"`、`grep '<<EOF' file` 引号内 `<<` 被误判 heredoc → 配合未闭合规则 → **合法命令被拒** | 改为逐字符扫描、跳过引号内 `<<` |
| 边界误判②：注释判定词首 | `${x}#foo`、`a#b`、`$#` 若把 `#` 一律当注释起始会误跳行尾文本 → 误判 | 词首 = 文本开头/空白/`;` `&` `|` `(` `)` `<` `>`；上述三者均非注释（`isPosixCommentStart`） |
| 边界误判③：pwsh here-string 起始不看引号 | `Write-Output "foo@"` 被误判起始 → 被拒 | 要求 `@"` / `@'` 在引号外且词首（`pwshHereStringStart`） |

### 验证

- 检测器矩阵 **81 条断言全 PASS**（脚本 `.tmp/check-continuation.mjs`，日志 `.tmp/check-continuation.log`）。
- 端到端 5 项全通过：本地 pwsh 多行回显剥离、SSH zsh 多行无回归、`ls # don't` 可执行、
  未闭合 heredoc / `{` 被拒、`echo "a << b"` 正常执行。

### 已知限制（续行检测）

| 项 | 说明 |
|---|---|
| 控制关键字结构未检测 | POSIX `if…then` 缺 `fi`、`do` 缺 `done`、`case` 缺 `esac`；pwsh 同类。正确检测需关键字级解析、易误判，**故不做**——这类命令会卡住，但 busy 保持、可 Ctrl-C |
| 同一行多个 heredoc | `cat <<A <<B` 只跟踪第一个分隔符 |
| 拒绝文案通用 | 续行提示文案目前是通用的 "unclosed quote/backtick/escape"，未细分 heredoc / 括号深度等原因 |

## 6. 服务锁陈旧导致服务无法启动（自愈）

### 现象

异常关闭 / 崩溃后重启，服务再也起不来。

### 根因

`ensureServer` 用 `mkdir server.lock` 当原子锁、靠 `finally` 释放；崩溃**不走 finally** → 残留空锁目录 →
后续每次启动只等 5s 就放弃返回空。

### 修复（`src/server-manager.ts`）

| 步骤 | 实现 |
|---|---|
| 持锁留痕 | 拿到锁后写 `server.lock/owner.json`（`pid` + `ts`） |
| `clearStaleLock()` | 有属主：属主进程已死（`isAlive`）或锁超绝对上限 `LOCK_ABS_STALE_MS = 60_000` → 删锁；无属主（信息缺失/写入失败）：超 `LOCK_NOINFO_STALE_MS = 5_000` → 删锁 |
| `acquireLock()` | `mkdir` 失败先清陈旧锁再重试一次 |
| 等待循环 | 每轮重试 `acquireLock()`，以便持有者中途死亡时抢占 |

### 验证

造空锁目录（mtime 设为 1 小时前）后调用 `ensureServer(49263)`：自动清理并起服务、`/health` 返回 200、锁释放。

## 7. 常量与协议

| 项 | 值 | 说明 |
|---|---|---|
| `SERVER_PROTO_VERSION` | `12` → `13` | server 代码变更（§3），须提升版本以触发旧 server 进程替换 |
| `ShellAdapter.windowsShell` | `true`（pwsh/cmd）/ `false`（zsh/bash） | 该 shell 是否运行在 Windows 控制台（ConPTY）；`_composeCommand` 据此决定写入行分隔符 |
| `_lineSep`（`BaseSession`） | 默认 `"\n"`（SSH+POSIX）/ `"\r"`（`LocalSession` 覆盖） | 行分隔符**回退值**：仅当 `windowsShell` 不为 `true` 时由 `_composeCommand` 采用；`_composeEchoText` 恒为规范 `\n`（§4） |
| `LOCK_OWNER` | `owner.json` | 锁属主文件名（`pid` + `ts`） |
| `LOCK_NOINFO_STALE_MS` | `5_000` | 无属主信息的锁视为陈旧的空闲时长 |
| `LOCK_ABS_STALE_MS` | `60_000` | 有属主信息的锁的绝对上限 |

> 追加批次的常量（`TERM_SCROLLBACK_LINES`、`SYNTAX_QUIET_MS`、`SYNTAX_MAX_WAIT_MS`、`ShellAdapter.syntaxErrorRe`）见 §11 / §12 各自表格，本表不重复。

## 8. 涉及文件

| 文件 | 改动 |
|---|---|
| `src/base-session.ts` | 新增 `_composeEchoText`（多行包组 + 标记同行拼接，恒返回规范 `\n` 匹配形式）；新增 `_composeCommand`（写入形式：行分隔符 `= windowsShell ? "\r" : _lineSep`，`\n` → 该分隔符 + 尾 `\r`）；新增 `protected _lineSep`；删除 `splitCommand` |
| `src/shell-adapter.ts` | 接口新增 `stmtSep` / `windowsShell` / `groupWrap`，4 个适配器实现（`windowsShell`：pwsh/cmd → `true`，zsh/bash → `false`）；删除 `splitCommand`、`splitByContinuation`、`hasHeredoc`；重写 3 个 `*OpenContinuation` 检测（注释 / heredoc 闭合 / 括号深度 / here-string，见 §5），`heredocDelim` 改逐字符引号感知，新增 `isPosixCommentStart`、`pwshHereStringStart` |
| `src/agent.ts` | 删除 `AgentSession.splitCommand` 声明与 `run-exec` 多行拆分分支 |
| `src/local-session.ts` | 覆盖 `_lineSep = "\r"` |
| `src/server.ts` | `buildRawFromHistory` cmd 分支行尾规范化（`\r?\n` → `\r\n`） |
| `src/server-manager.ts` | `owner.json` 留痕、`clearStaleLock()`、`acquireLock()`、等待循环每轮重试 |
| `src/constants.ts` | `SERVER_PROTO_VERSION` 13 |

> 本表覆盖 §2–§6；追加批次涉及的文件见 §11「修复」表与 §12「修复」表（含新增文件 `src/ansi.ts`、`package.json` 依赖变更）。

## 9. 与旧文档的关系

| 旧文档 | 关系 |
|---|---|
| `终端渲染与尺寸固定说明.md` **G10** | G10 的「heredoc 感知拆分」（`splitByContinuation` 把 `<<EOF` 至分隔符行整体并入同一条命令）**已被本文件 §2 取代**：不再拆分，含 heredoc 的多行命令同样整体包组，heredoc 分隔符行天然独占一行，标记拼在组尾而非分隔符行。G10 其余修复（`stripCommandTail` 只对最后一行去尾注释、续行检测跳过 heredoc 正文行）仍然有效；G10 条目按约定**不改动原文**，以本文件为准 |
| `终端渲染与尺寸固定说明.md` §3 续行检测 | 接口与行为约定不变（`hasOpenContinuation` 保留，不完整命令仍拒绝提交）；**判定规则本轮后续修正**（见 §5），§3 所描述的检测范围（未闭合引号/反引号/行尾反斜杠）已扩大 |
| `终端渲染与尺寸固定说明.md` §2/§4 尺寸与常量 | 不受影响（`120×40` 不变）；仅 `SERVER_PROTO_VERSION` 由 11 → 12 → 13 递增 |
| `多语言配置说明.md` | 不受影响，无文案/字典变更 |
| `消息协议重构设计.md` | 不受影响，消息形状无变更（仅协议版本号递增） |
| `结构设计.md` | §11 已回填：`utils.ts` 的 `toModelText` 标注为 `@xterm/headless` 屏幕模拟并声明 `Promise<string>`；旧函数 `simulateScreen` / `cleanAnsi` / `stripEcho` / `collapseCarriage` 标记为已移除 |
| `终端渲染与尺寸固定说明.md` §G（transcript 渲染） | transcript 渲染实现原为自研 `TermScreen`，**已由本文件 §11 改为 `@xterm/headless`（`HeadlessScreen`）**；该文档条目按约定不改动原文，以本文件为准 |

## 10. 已知限制与风险

| 项 | 说明 |
|---|---|
| 续行检测自身限制 | 控制关键字结构（`if…then` 缺 `fi` 等）不检测、同一行多个 heredoc 只跟第一个、拒绝文案通用——详见 §5 已知限制 |
| cmd 多行命令 | 不包组（`groupWrap` 返回 `null`），仍为逐行执行，中间输出丢失问题在 cmd 下**未解决**；仅完成标记因 `stmtSep = "&"` 而恢复正常 |
| 包组的副作用 | 整段多行成为一条命令后，`history` 记录为一条（含组语法），与逐行执行的记录形态不同 |
| `owner.json` 写入失败 | 不影响持锁，仅失去属主判定依据，退化为「无属主 → 超 5s 即清理」路径 |
| 屏幕模拟可见内容有上限 | 模型文本 / transcript 可见内容 = 屏深（`40` 行）+ `TERM_SCROLLBACK_LINES`（2000）行；更久远的输出被终端语义自然丢弃（§11 事实注记），非缺陷 |
| 语法错误收尾的输出尾部可能残留一行提示符 | `stripTrailingPromptLine` 仅在归一化后**整行完全相同**时剥离；用户自定义提示符含动态内容时剥不掉。已确认不再加固（§12 已知限制） |
| cmd 语法错误不识别 | `syntaxErrorRe = null`：报错文案本地化、无法按字节稳定识别；cmd 用 `&` 分隔，标记仍会执行，不受整行作废问题影响（§12） |

## 11. transcript 与模型文本改用 `@xterm/headless`（追加批次一）

### 背景问题

模型侧文本（`src/utils.ts` 的 `toModelText`）与浏览器 transcript（`web/src/main.ts`）原先各自使用**自研屏幕模拟器**
（`simulateScreen` / `TermScreen`）解析原始字节流。自研实现缺**滚动**语义：CUP（`ESC[<r>;<c>H`）把光标拉回屏幕
**底行**后再写入，会直接**原地覆盖**该行，内容也不进入 scrollback。

实测后果：raw 中完整的多行错误块，经模型侧只剩**最后一行**（1 行 31 字符），上一行错误文案永久丢失——模型看不到错误原因。

### 修复

| 侧 | 位置 | 改动 |
|---|---|---|
| 模型侧 | `src/utils.ts` | 删除自研 `simulateScreen`；`toModelText` 改用 `@xterm/headless` 的 `Terminal`（`cols/rows = PTY_COLS/PTY_ROWS`、`scrollback = TERM_SCROLLBACK_LINES`、`allowProposedApi: true`），写入后从 `buffer.active` 逐行 `translateToString(true)`，行尾去尾空白并剔除空行 |
| 浏览器侧 | `web/src/main.ts` | 删除自研 `TermScreen`；新增 `HeadlessScreen`：`write` 串行队列（`queue = queue.then(writeOnce)`）保证顺序与最终一致；**身份守卫防竞态**（`await write` 期间若被新命令 `resetRunScreen()` 替换 `runScreen`，则放弃本次渲染）；`render()` 逐 cell 取字符/前景/背景/粗体并合并相邻同样式 |
| 依赖 | `package.json` | 新增 `@xterm/headless` `^5.5.0`（与已有 `@xterm/xterm` `^5.5.0` 同版本线，渲染语义一致） |
| 常量 | `src/constants.ts` | 新增 `TERM_SCROLLBACK_LINES = 2000`（模型侧）；web 侧 `SCROLLBACK_LINES = 2000` 与之对齐，两侧同 `cols/rows/scrollback` |

- **颜色按 palette 重建**：headless 只给出色号，`HeadlessScreen` 还原为 CSS 颜色——0-7 基本色 / 8-15 亮色（沿用既有
  `ANSI_BASE` / `ANSI_BRIGHT`）、16-231 为 6×6×6 色立方（`COLOR_CUBE_STEPS`）、232-255 灰度阶、非 palette 色按 `#rrggbb` 直取；
  默认色返回 `null`（不设 style）。
- **保留原有标注 UI**：耗时 / 退出状态仍由 `resultMeta` 追加到最后一行，transcript 块固化路径不变。

### 事实注记（勿误记为缺陷）

- CUP 回到底行再写入时，那一行的原内容会丢失——这是**合规终端语义**（真实终端上滚出屏幕、超出 scrollback 的内容同样不可见），
  不是 `@xterm/headless` 或本项目的缺陷。换用真引擎后，可见内容 = 真机屏幕 + scrollback 深度内的历史。
- `term.buffer` 属 **proposed API**：构造时必须 `allowProposedApi: true`，否则访问抛
  `You must set the allowProposedApi option to true to use proposed API`。
- `@xterm/headless` 为 CommonJS，Node ESM 无法静态识别其具名导出，故 `src/utils.ts` 从默认导出解构 `Terminal`。

### 副作用

`toModelText` 因 xterm `write` 为异步，签名由 `string → string` 改为 `string → Promise<string>`；所有调用点补 `await`：
`src/base-session.ts` 的 `exec`（done / interactive / running 取末条 history 输出）与 `readBuffer`，
以及 `src/index.ts`（历史 `read` 组装 parts 改为逐条顺序 `for` 循环——同步 `map` 无法等待异步 write）。

### 验证

| 项 | 结果 |
|---|---|
| 模型侧回归（真实缓存字节） | 改造前自研模拟器：1 行 31 字符，只命中「请检查名称的拼写…」；改造后 headless：2 行 73 字符，错误块两行都在（`.tmp/refactor-headless.log`、`.tmp/refactor-regress.log`） |
| web 侧 | 打包产物确认 `allowProposedApi` 与串行 write 队列存在；raw / transcript 视觉一致由人工对照确认 |

## 12. shell 语法/解析错误作为完成信号（追加批次二）

### 背景问题

pwsh 的**解析错误（`ParserError`）使整行命令作废**：完成标记与命令拼在同一行
（`; Write-Output "<SSH_DONE:N:...>"`），整行不进入执行 → 标记**永不输出** → 工具等不到完成信号 →
一直 busy、输出不落地。用户实测：此类命令卡住，只能 Ctrl-C。

对照：**运行期错误**（command not found、非 0 退出码等）**不作废整行**，同行标记照常执行 → 属正常完成路径，本改动不影响它。

### 修复

| 层 | 位置 | 改动 |
|---|---|---|
| 模式 | `src/shell-adapter.ts` | `ShellAdapter` 新增 `readonly syntaxErrorRe: RegExp \| null`：pwsh → 行首 `ParserError:`（**大小写敏感**）；zsh / bash → `POSIX_SYNTAX_ERROR_RE`（行首可选「路径 + shell 名 + 位置链」前缀 + `syntax error` / `parse error`，大小写不敏感以兼容 dash 的 `Syntax error`）；cmd → `null` |
| 检测 | `src/shell-adapter.ts` | 新增 `detectSyntaxError(adapter, buffer, fromPos)`：**先 `stripAnsi` 剥净窗口内全部转义序列，再按行首判定**；模式不带 `g`，`test` 无状态 |
| ANSI 单一来源 | `src/ansi.ts`（新增文件） | `ANSI_SEQ_PATTERN`（CSI 含 `?` / `;` 参数，覆盖 `\x1b[?25l`、`\x1b[39;1H`；OSC；双字节 ESC）+ `stripAnsi()`；`src/utils.ts` 的 `ECHO_WIDE` / `TAIL_ANSI` 与提示符比较用的 `normLine` 改为复用该来源（不再各自定义） |
| 前台等待 | `BaseSession._waitCompletion` | 每轮**最先**跑语法检测（优先于交互提示与「判为 running」）；命中后不立即收尾，先等输出安静：停止增长达 `SYNTAX_QUIET_MS = 300`，或自首次识别达 `SYNTAX_MAX_WAIT_MS = 1_000` 上限。返回 `{ kind: "done", exitCode: null, syntaxError: true }`，`markerPos` 缺省 → 输出窗口取到缓冲区末尾 |
| 后台 watch | `BaseSession._startBackgroundWatch` | 同一安静窗口规则；命中后走**与正常完成一致的收尾路径**：`_extractOutput(..., syntaxMode = true)` → `_history.append` → `done` 事件 → `_clearRunningContext` → busy 按 `_holdBusy` 翻转 |
| 输出提取 | `BaseSession._extractOutput` / `extractOutputStart` | 语法路径下回显定位改用 `first = true` **首次匹配**：pwsh 错误块的 `   1 \|  <命令>` 行会重印含标记的整行命令，末次匹配会落到该拷贝上，把 `ParserError:` / `Line \|` 等错误块**前半裁掉** |

**为何必须先剥 ANSI（首版失效的根因）**：初版只容忍 SGR（`\x1b[...m`），而真实 ConPTY 的错误块前带
`\x1b[?25l`（隐藏光标）、`\x1b[39;1H`（光标定位）等**非 SGR** 序列 → 行首锚定匹配不上 → 信号永不触发、busy 照旧卡死。
剥 ANSI 会使字节偏移失真，但该信号只回答「是否已结束」，不需要位置。

### 明确不做

不加「无标记即超时完成」式兜底：静默长命令（`sleep 60`、无输出的构建）会被误判为已完成。
语法错误以外的「标记迟迟不出现」仍由用户 Ctrl-C 干预（TTY 回显 `^C` → `exitCode 130`）。

### 尾部提示符剥离（已知限制，已决定不加固）

语法错误收尾时 shell 会重印提示符行，`stripTrailingPromptLine(out, window, promptRef)` 用两个候选基准比较：
捕获窗口首个非空行、命令发起前的缓冲末行（`BaseSession._promptRef`，在 `_beginCapture` 记录）。
比较是**归一化（剥 ANSI、去尾 `\r` 与尾空白）后要求整行完全相同**。

- **限制如实说明**：提示符可能被用户自定义（含 git 分支、耗时、退出码等动态内容），新旧行**多数情况下并不相同** →
  剥不掉，输出尾部可能带一行提示符。
- **不继续加固**：不引入模糊 / 包含匹配——那会误删与提示符形状相似的正常输出行，代价更高。作为已知限制保留。

### 新增常量

| 项 | 值 | 说明 |
|---|---|---|
| `SYNTAX_QUIET_MS` | `300` | 语法错误识别后等输出安静的时长：pwsh 错误块由格式化器异步/批量渲染，立即收尾会只截到首行 |
| `SYNTAX_MAX_WAIT_MS` | `1_000` | 自首次识别起的最长等待，防错误块持续刷新迟迟不收尾 |
| `ShellAdapter.syntaxErrorRe` | 见「修复」表 | `null` 表示该 shell 不支持识别（cmd） |

### 验证

| 项 | 结果 |
|---|---|
| 检测器单测 | **74 例全 PASS**（`.tmp/check-syntaxerr2.mjs`，日志 `.tmp/check-syntaxerr2.log`）：含 `\x1b[?25l\x1b[39;1HParserError:` 必中（非 SGR / SGR 混合 / OSC 前缀 / 缓冲区中间 / bash·zsh·dash 各形态）+ **14 个反例不误判**（行中出现同名词如 `echo xParserError:y`、`ParserError` 缺冒号、引号内或行中普通文本含 `syntax/parse error`、正常输出与提示符、只有 ANSI 无错误词、错误位于 `fromPos` 之前、`null` 适配器与 cmd） |
| 端到端（合成字节） | `exec` ~0.4s 收尾（实测 407ms / 377ms，含 300ms 安静窗口）、`submit` 后台 watch 641ms；5 行错误块完整且顺序正确；`done` 事件 `exitCode = null`；history 落盘含整段错误块、不含尾部提示符行 |
| 回归矩阵 | 续行检测 81/81、边界用例 9/9 无回归 |
| **真机**（Windows pwsh over SSH） | 长行 `''` + `\"` 的解析错误命令 ~0.5s 收尾、5 行错误块完整；运行期错误仍走标记路径，不受影响 |
