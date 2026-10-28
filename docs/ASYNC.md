# 异步 / 并发交互点清单

> 本文件登记本插件里**跨异步边界共享的状态与顺序契约**。新增或修改异步/并发逻辑时同批更新本文件。
> 当前范围：SFTP 文件传输（v1）、发送前远程语法预检与 read 只读快照（v0.7.3）。终端命令执行/完成标记的并发细节见 `docs/design/结构设计.md` §5。

## 1. 总览

| 交互点 | 共享状态 / 资源 | 保护手段 | 顺序契约 | 位置 |
|---|---|---|---|---|
| 同一 `SshSession` 的多次 upload/download | `_transferChain`（Promise 链） | 串行队列：`then(job, job)`，失败也继续下一个 | 同一终端实例内传输严格按调用顺序执行；**前一个 job 真正 settle 后才开始下一个**。通道 error/超时不会提前结算：先中止 job 再等它结束，最多等 `TRANSFER_JOB_SETTLE_TIMEOUT_MS`（12s）兜底 | `src/session.ts`（`_enqueueTransfer` / `_withSftp`） |
| 传输 vs PTY 命令执行 | SSH `Client`、`_remoteBusy`、PTY `_stream` | 不使用共享缓冲；SFTP 走独立 channel；不读写 `_buffer` / 不翻转 busy | 传输与命令可并行；传输不占用 PTY，命令也不会因传输被判 busy | `src/session.ts`（`_withSftp` / `uploadFile` / `downloadFile`） |
| 传输 vs 会话关闭 | `_client`、`_connected`、`_closed` | 排队任务在真正开始时才检查 `_connected` / `_client`；连接已断直接 `sftp_unavailable` | 关闭后排队的传输全部失败，不会在半死连接上新建 channel | `src/session.ts`（`_withSftp`） |
| SFTP channel 生命周期 | 每次传输一个 `SFTPWrapper` | `_withSftp` 任务成功/失败后 `sftp.end()`；超时/通道错误用 `destroy()`；`sftp.on("error")` 常驻监听（ssh2 ready 后已移除内部监听） | 一次传输 = 一个 SFTP subsystem；通道错误只中止本次传输并记日志，**不**把整个 SSH 会话判死、不影响 PTY | `src/session.ts`（`_withSftp`） |
| 超时 / 通道错误 vs 传输继续运行 | 整个传输的 Promise、SFTP channel、读写流、`AbortSignal` | `TransferDeadline` 全链路共享剩余时间；会话层超时/通道 error 通过 `AbortSignal` 让传输立即拒绝；`withTimeout` 单次结算；超时 `destroy()` 通道 + 销毁流 | 开通道 / realpath / stat / mkdir / 读写 / rename 都受同一 deadline；`deadline.check()` 保证**不再主动发起新的 rename/commit**；已发出的 rename 仍可能被服务端执行 | `src/session.ts`（`_withSftp`）/ `src/transfer.ts`（`TransferDeadline.abort` / `registerExternalAbort`） |
| 超时/失败 vs 临时文件清理 | 远端/本地临时文件、独占创建的部分文件 | 远端清理/失败路径探测统一用 `TRANSFER_CLEANUP_TIMEOUT_MS`（3s）；本地直接 `unlink` | 失败不覆盖原始错误；超时后也尽力清理，但通道不可用时 3s 内放弃 → **无 `--overwrite` 时目标路径可能残留半截文件（重试报 `exists`）**，`--overwrite` 时可能残留 `.part`/`.bak` | `src/transfer.ts`（`bestEffortUnlinkRemote` / `remoteLstatOrNullWithin` / upload/download catch） |
| 默认不覆盖（独占创建） | 远端/本地目标路径 | 上传远端 `flags:"wx"`；下载本地先 `fs.open("wx")` 再流式写 | **真正不覆盖由 EXCL/EEXIST 原子保证**；预检（`lstat`）只用于错误归类，存在检查-写入窗口但不影响“不覆盖” | `src/transfer.ts`（`uploadStream` / `openLocalExclusive`） |
| overwrite 提交回退 | 临时文件、旧目标、备份 | rename 先尝试直接覆盖；失败且确认目标存在才备份旧目标（剩余时间不足 2s 不开始回退） | 备份 → 新文件就位 → 删备份；**已备份但新文件未就位的所有分支都尽力回滚**（不受剩余 deadline 限制，用清理预算）；回滚失败时旧目标保留在备份路径，错误 detail 带该路径 | `src/transfer.ts`（`commitRemoteOverwrite` / `commitLocalOverwrite` / `rollbackRemote` / `rollbackLocal`） |
| 多终端 / 多插件进程 | 各自独立的 `SshSession` / 队列 | 无跨实例锁 | 不同终端名的传输可并行；**不保证**跨终端/跨进程对同一远端目标的互斥（v1 不引入文件锁） | `src/index.ts`（会话表） |
| 日志与工具输出 | `log.tool`、工具回执 | 只记录方向/路径/实际字节/耗时/ok/错误码 | 任意异步分支都不得把文件内容写入日志、history、模型输出 | `src/index.ts`（`doTransfer`） |
| 传输进度回调 vs 传输本身 | `onProgress` 回调（调用方可能做节流/发送） | `transfer.ts` 用 `reportProgress` 包裹，回调抛错直接吞掉 | 进度只做展示：回调同步失败**不得**中止/回滚传输；首次 `(0,size)` 在 stat 后、每块数据后回调 | `src/transfer.ts`（`reportProgress` / `pipeWithLimit`） |
| 进度事件节流 vs 传输完成 | `transferTask`、`lastBytes/lastTotal`、`progressTimer` | 单线程闭包状态；窗口内只挂一个尾沿定时器；完成/失败先清定时器再发终态 | 进度事件约 250ms 节流；终态 `done`/`failed` 必达且带最终字节/总数；任务只含元数据 | `src/index.ts`（`doTransfer`） |
| 传输任务事件 vs server 清理 | `transferTasks` / `transferSeenAt`（Map） | server 单事件循环串行处理；每次上报刷新 `transferSeenAt`；清理定时器 `unref` | running 超过 `TRANSFER_TASK_STALE_MS` 无更新移除；done/failed 保留 `TRANSFER_TASK_TTL_MS`；移除时广播 `transfer-remove{id}`；`list` 快照 `scope:"all"`，`subscribe` 按 `sessionID`+`name` 只返回当前选中终端任务；广播与快照同源 | `src/server.ts`（`sweepTransferTasks` / `broadcastTransfer` / `broadcastTransferRemove` / `transferSnapshot`） |
| agent 断开 vs 运行中传输任务 | `agents` / `agentBySession` / `transferTasks` | WS `close` 时按该连接 `register` 认领的 `sid:name` 集合筛选；server 单事件循环串行 | 只把该 agent 认领终端上仍为 running 的任务改为 `failed`（`endedAt=Date.now()`、`errorCode="agent_disconnected"`）并广播；其他 agent/终端任务不动 | `src/server.ts`（`ws.on("close")`） |
| 传输任务快照 vs Web 端本地视图 | Web 内存 `transferTasks`（`web/src/main.ts`） | 单线程消息处理器串行；广播按 `id` upsert/删除 | `transfers{scope:"all"}` 全量替换；`transfers{sessionID,name}` 只替换该会话该终端、保留其他终端/会话；`transfer-remove{id}` 删除指定行；切换终端后由 server 终端级快照切换列表、切换会话按新会话/终端快照纠正，排序固定为 running 优先 + `startedAt` 降序 | `web/src/main.ts`（`applyTransferSnapshot` / `upsertTransferTask` / `removeTransferTask` / `renderTransferPanel`） |
| 远程语法预检 vs PTY 命令执行 / 连接状态 | `_client`、独立的 exec channel | 不复用 PTY `_stream`；不读写 `_buffer`/history、不翻转 busy、不改 `_connected`；pwsh 只读 stdout 协议行，不向终端写任何内容 | 预检在命令提交前完成（agent 路径在队列出队时）；通道结束/超时只影响本次预检，主命令照常放行 | `src/precheck.ts`（`precheckBeforeExec`）/ `src/session.ts`（`precheckSyntax`） |
| 预检 channel 生命周期与超时 | 每次预检一个 `ClientChannel`、`timer`、`settled` 标志 | `settle()` 单次结算并清定时器；超时 `destroy()` 通道；`exit` 只记录退出码，`close` 结算；stdout/stderr 各截尾 16KB | 一次预检 = 一个独立 exec channel；bash/zsh 单通道；任何错误/超时/无退出码/非语法失败 → `{ok:true}`（fail-open），绝不让主命令等待 | `src/session.ts`（`_execSyntaxCheck` / `_runPwshCandidate`） |
| pwsh 预检候选回落 vs 总超时 | 候选列表、共享 deadline | 只有「候选不可用」（127/9009/命令不存在文案）才换下一个；`ERROR=1`、通道错误、无协议响应非语法失败立即放行；每个候选独立 channel，结算时清 timer / `destroy()` | 候选串行、不重试同一候选；`pwsh → powershell → powershell.exe` 共享 `REMOTE_PRECHECK_TIMEOUT_MS` 总预算；绝不触碰 PTY/busy/history/`_connected` | `src/session.ts`（`_execPwshSyntaxCheck` / `_runPwshCandidates` / `_runPwshCandidate`） |
| 预检失败 vs 命令拦截 | `ParseCheckResult` | 本地 parse-check 与远程 exec channel 两分支互不复用；远程未实现/异常/超时/结构异常一律 `null` | 只有 `{ok:false}` 且 `errors` 非空才拦截；预检故障不改变权限判定与执行队列 | `src/precheck.ts` |
| read 只读快照 vs 命令运行/完成收尾 | `_buffer` / `_cursor` / `_streamPos` / `_runningStartPos` / history | `peekBuffer()` 在 `await toModelText` 前**同步**切出字符串快照；只读，不写任何会话状态，也不调用 `_completeRunning` | 等待渲染期间新到达的输出不进入本次结果；命令运行/收尾可并发改变缓冲，但读取路径绝不回写，故不会消费输出、写 history 或翻转 busy | `src/base-session.ts`（`peekBuffer`）/ `src/index.ts`（`doRead`） |

## 2. 不变量

1. **仅 SSH**：文件传输只存在于 `SshSession`；`LocalSession`（docker/wsl 等）没有 `uploadFile` / `downloadFile`，`runSshTransfer` 先 `instanceof SshSession` 拒绝，且不会触发审批。
2. **串行化范围 = 一个 `SshSession` 实例**（一个命名终端）。排队不阻塞 PTY 命令。**通道 error / 超时不提前结算**：立即中止 job 并等它 settle 后再 finish（兜底上限 `TRANSFER_JOB_SETTLE_TIMEOUT_MS` = 12s，此时通道已中止，job 无法再提交）。
3. **每次传输独立 channel**：开始打开 SFTP subsystem；成功/失败 `end()`，超时/通道错误 `destroy()`；`error` 监听常驻，避免未捕获 error 扩散到 Client。
4. **默认不覆盖是原子的**：无 `--overwrite` 时用独占创建（远端 `wx` / 本地 `open("wx")`），目标存在直接 `exists`；预检只用于错误归类，不承担“不覆盖”的保证；`--overwrite` 才临时文件 + rename。
5. **中止后不主动提交**：共用 deadline；超时/外部中止会中止通道/流并阻止发起**新的** rename/commit，但已发出的 rename 仍可能被服务端执行；无 `--overwrite` 时目标路径可能残留半截文件，`--overwrite` 时可能残留 `.part`/`.bak`，本地部分文件必须清理。
6. **不重试、不自动改名、不自动备份**：失败即返回；overwrite 回退只在确认目标存在且剩余时间足够时进行；已备份后的失败分支尽力回滚，回滚失败时旧目标保留在备份路径并在错误中给出该路径。
7. **进度回调是旁路**：`onProgress` 只读地接收 `(bytes,total)`，不得改变传输结果；回调抛错被吞掉。空文件也应收到一次 `(0,0)`。
8. **任务事件只含元数据**：`TransferTask` 不含文件内容；index 只在上报前组装白名单字段，server 用 `parseTransferTask` 再校验一次；任务不写盘，server 重启即丢；无 agent 时 index 静默不上报。
9. **字节数校验先于 done**：`pipeWithLimit` 在结算前校验 `totalSize > 0 && bytes !== totalSize`；不一致必须报 `io` 并清理，短读/短写不得被当作成功。
10. **read 默认路径只读**：未显式 `-s` 且 `busy=true` 时只调用 `peekBuffer()`；任何读取路径都不得消费 `_buffer`、写 history、翻转 busy 或发 done。只有显式 `-s buffer` 保留旧的 `readBuffer()` 消费语义。

## 3. 验证方式（可核验）

- 单测 `test/transfer.test.mjs`：默认 `wx` 独占创建（目标存在不写流）；预检后被抢建仍 `exists` 且原内容不变；`--overwrite` 临时文件 + rename；rename 失败备份/回滚；回滚成功抛原错误、回滚失败错误 detail 带 `.bak` 路径；`--mkdir` 逐级创建；目录/符号链接/超限拒绝；超时（realpath/写流挂起）不写不提交且尽力清理目标残留；失败清理；写流提前 close（短写）报 `io` 且不按 done 结算；`_withSftp` 通道 error/开通道超时不拖死会话、下一个队列任务不早于前一个 job settle；参数个数；`runSshTransfer` 的 SSH 判定与审批顺序；`onProgress` 首帧 `(0,size)`、bytes 单调、空文件 `(0,0)`、回调抛错不中断。
- 单测 `test/transfer-events.test.mjs`：`parseTransferTask` 合法/缺字段/非法 direction/state/超长路径/非法数值；未知字段（含伪文件内容）被剥离。
- 集成测试 `test/server-transfer.test.mjs`：`startServer(0)` + ws 模拟 agent 上报 `transfer`，Web 收到广播与 `list`/`subscribe` 快照；`list` 为 `scope:"all"`、`subscribe` 返回该会话全部终端任务（不按 name 过滤）；非法任务与 Web 伪造任务被忽略；agent 不回发任务；agent 断开后其认领终端上的 running 任务变为 `failed`（`agent_disconnected`）并广播，其他 agent 任务不受影响。
- 并发/顺序的代码级检查：`src/session.ts` 中所有传输必须经过 `_enqueueTransfer` → `_withSftp`，不得在别处直接调用 `client.sftp()`；超时/提交前必须有 `deadline.check()`。
- 日志检查：`log.tool("file_upload" | "file_download", …)` 字段只允许路径/实际字节/耗时/ok/code，不包含文件内容。
- 单测 `test/precheck.test.mjs`：远程 `precheckSyntax` 返回 ok → `null`；返回 errors → 拦截文案（含 pwsh 的真实 ErrorId）；抛异常/超时/未实现/结构异常 → `null`；本地仍走 parse-check 且不调用远程方法；`parsePwshSidecarResponse` / `PS_SIDECAR_ENCODED_COMMAND` / `encodePwshSidecarPayload` 协议稳定性。
- 单测 `test/session-precheck.test.mjs`：fake SSH client 验证 `pty:false` + 命令经 stdin 写入；exit 0 / exit 2 语法错误（bash/zsh，含中文 `行 N`）/ 非语法 127 / 通道打开失败 / 通道 error / 非 bash-zsh-pwsh / 未连接 → 放行；pwsh 侧车 `ERRCOUNT=0`/`ERRCOUNT=1`/`ERROR=1`/`pwsh` 不存在回落 `powershell`/候选全不可用/无响应/命令超长/通道打开失败/单候选超时销毁通道。
- 单测 `test/peek-buffer.test.mjs`：`peekBuffer` 多次读取后 `_buffer`/`_cursor`/`_streamPos`/`_runningStartPos`/busy/history 对数全部不变；运行中只返回 `_runningStartPos` 之后；未连接返回错误且不改状态；显式 `readBuffer` 空闲/命中完成标记仍按旧语义消费（清缓冲、写 history、busy=false）；`readBusyNotice` 仅在 busy=true 输出中英文前缀与警告。
