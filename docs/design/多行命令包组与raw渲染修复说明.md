# 多行命令包组与 raw 渲染修复说明

> 本文件为变更说明文档，记录五项改动：多行命令统一包组（删除多行拆分）、离线会话 raw 阶梯错位修复、
> 本地/容器会话（Windows ConPTY）多行命令乱序修复、续行/完整性检测修正、服务锁陈旧自愈。
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

## 4. 本地/容器会话（Windows ConPTY）多行命令乱序修复

### 现象

本地 pwsh 会话里多行命令行序错乱、停在 `>>` 续行提示、随后被中断。

### 根因

**ConPTY 下裸 `\n` 不提交行**（需 `\r`）；而 SSH 的 Unix PTY 下裸 `\n` 可以正常提交。已实测两者行为差异。
§2 包组后，组语法内部依赖换行真正提交行，ConPTY 场景下 `\n` 不提交 → 包组失效并错乱。

### 修复：匹配形式与写入形式解耦

组合文本分两种形式，`_lineSep` 改写**只发生在写入形式**：

| 成员 | 位置 | 职责 |
|---|---|---|
| `_composeEchoText(command)` | `src/base-session.ts` | **规范形式（恒 `\n` 分行、无尾部回车）**：包组 + 标记同行拼接；供 `extractOutputStart` 按 `\n` 切行、段间宽松匹配跳过 `>>` / `>` 续行提示 |
| `_composeCommand(command)` | `src/base-session.ts` | **写入 PTY 形式**：`_composeEchoText(...).replace(/\n/g, this._lineSep) + "\r"` |
| `_lineSep` | `BaseSession` 默认 `"\n"`（Unix PTY） | 写入 PTY 的行分隔符；`src/local-session.ts` 覆盖为 `"\r"`（Windows ConPTY） |

**为何必须解耦（实测）**：初版实现是在 `_composeEchoText` 返回前把 `\n` 替换为 `_lineSep`——
本地会话（`\r`）下组合文本不含任何 `\n`，`extractOutputStart` 按 `\n` 切行时整段成为一行，
段间宽松匹配失效 → **命令回显剥离失败**（本地 pwsh 多行命令的 history 里带着整段回显与会话残留噪音）。
解耦后实测：本地 pwsh 多行命令返回纯 `x=7 loc=D:\tmp`，history 记一条。

实测：本地 pwsh 用 `\r` 后行序正确、组内作用域保留、marker 正常。

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
| `_lineSep`（`BaseSession`） | `"\n"`（SSH）/ `"\r"`（`LocalSession`） | 写入 PTY 的行分隔符，仅 `_composeCommand` 使用；`_composeEchoText` 恒为规范 `\n`（§4） |
| `LOCK_OWNER` | `owner.json` | 锁属主文件名（`pid` + `ts`） |
| `LOCK_NOINFO_STALE_MS` | `5_000` | 无属主信息的锁视为陈旧的空闲时长 |
| `LOCK_ABS_STALE_MS` | `60_000` | 有属主信息的锁的绝对上限 |

## 8. 涉及文件

| 文件 | 改动 |
|---|---|
| `src/base-session.ts` | 新增 `_composeEchoText`（多行包组 + 标记同行拼接，恒返回规范 `\n` 匹配形式）；新增 `_composeCommand`（写入形式：`\n` → `_lineSep` + 尾 `\r`）；新增 `protected _lineSep`；删除 `splitCommand` |
| `src/shell-adapter.ts` | 接口新增 `stmtSep` / `groupWrap`，4 个适配器实现；删除 `splitCommand`、`splitByContinuation`、`hasHeredoc`；重写 3 个 `*OpenContinuation` 检测（注释 / heredoc 闭合 / 括号深度 / here-string，见 §5），`heredocDelim` 改逐字符引号感知，新增 `isPosixCommentStart`、`pwshHereStringStart` |
| `src/agent.ts` | 删除 `AgentSession.splitCommand` 声明与 `run-exec` 多行拆分分支 |
| `src/local-session.ts` | 覆盖 `_lineSep = "\r"` |
| `src/server.ts` | `buildRawFromHistory` cmd 分支行尾规范化（`\r?\n` → `\r\n`） |
| `src/server-manager.ts` | `owner.json` 留痕、`clearStaleLock()`、`acquireLock()`、等待循环每轮重试 |
| `src/constants.ts` | `SERVER_PROTO_VERSION` 13 |

## 9. 与旧文档的关系

| 旧文档 | 关系 |
|---|---|
| `终端渲染与尺寸固定说明.md` **G10** | G10 的「heredoc 感知拆分」（`splitByContinuation` 把 `<<EOF` 至分隔符行整体并入同一条命令）**已被本文件 §2 取代**：不再拆分，含 heredoc 的多行命令同样整体包组，heredoc 分隔符行天然独占一行，标记拼在组尾而非分隔符行。G10 其余修复（`stripCommandTail` 只对最后一行去尾注释、续行检测跳过 heredoc 正文行）仍然有效；G10 条目按约定**不改动原文**，以本文件为准 |
| `终端渲染与尺寸固定说明.md` §3 续行检测 | 接口与行为约定不变（`hasOpenContinuation` 保留，不完整命令仍拒绝提交）；**判定规则本轮后续修正**（见 §5），§3 所描述的检测范围（未闭合引号/反引号/行尾反斜杠）已扩大 |
| `终端渲染与尺寸固定说明.md` §2/§4 尺寸与常量 | 不受影响（`120×40` 不变）；仅 `SERVER_PROTO_VERSION` 由 11 → 12 → 13 递增 |
| `多语言配置说明.md` | 不受影响，无文案/字典变更 |
| `消息协议重构设计.md` | 不受影响，消息形状无变更（仅协议版本号递增） |

## 10. 已知限制与风险

| 项 | 说明 |
|---|---|
| 续行检测自身限制 | 控制关键字结构（`if…then` 缺 `fi` 等）不检测、同一行多个 heredoc 只跟第一个、拒绝文案通用——详见 §5 已知限制 |
| SSH 连到 **Windows 上的 pwsh / cmd** | 仍走 SSH 路径的 `_lineSep = "\n"`，理论上可能出现与 §4 相同的行序问题。**未实测**（无该场景目标），若复现则需按探测到的远端 OS 覆盖 `_lineSep` |
| cmd 多行命令 | 不包组（`groupWrap` 返回 `null`），仍为逐行执行，中间输出丢失问题在 cmd 下**未解决**；仅完成标记因 `stmtSep = "&"` 而恢复正常 |
| 包组的副作用 | 整段多行成为一条命令后，`history` 记录为一条（含组语法），与逐行执行的记录形态不同 |
| `owner.json` 写入失败 | 不影响持锁，仅失去属主判定依据，退化为「无属主 → 超 5s 即清理」路径 |
