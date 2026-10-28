# read 读取语义说明（v0.7.3）

## 背景

`term_cli read` 原先只有两种来源：`buffer`（`readBuffer()`，读取后消费缓冲）与 `history`（默认，读已完成命令）。模型在命令仍在运行时读 `buffer` 会清空缓冲、推进 `_cursor`，并可能触发完成收尾；这既丢失后续 `getRunningStream` / Web 推流所需的位置，也让「看一眼当前输出」产生副作用。

v0.7.3 起，**默认 read 在 busy 时改为非消费快照**，显式 `-s buffer` 保持旧语义（兼容）。

## 行为

| 调用 | busy=false | busy=true |
|---|---|---|
| `read`（未传 `-s`） | history（旧默认，输出格式不变） | `peekBuffer()` 只读快照 + `[read source=buffer busy=true]` 前缀与警告 |
| `read -s buffer` | `readBuffer()`：读取并清空缓冲 | `readBuffer()` 旧语义（可能收尾/消费）；仅**调用后仍 busy** 才加前缀与警告 |
| `read -s history` | history | history + `[read source=history busy=true]` 前缀与警告（history 不含当前结果） |

`read` **不是等待机制**：它不会阻塞到命令完成。要等结果先调用 `status`，确认 `busy=false` 后再读。

## 非消费保证（`peekBuffer()`）

有运行中命令时返回 `_runningStartPos` 之后的片段，否则返回整段缓冲。实现只做字符串切片，且切片在 `await toModelText` **之前**同步完成：

- 不改 `_buffer` / `_cursor` / `_streamPos` / `_runningStartPos` / `_runningCommand`
- 不调用 `_completeRunning`：不写 history、不发 done 生命周期事件、不翻转 busy
- 只在未连接时返回 `ok:false`（`err_not_connected`）
- 展示处理与 `readBuffer()` 一致：`_stripProbeEchoes` → `toModelText` → `_truncate`

## buffer 消费路径审计（v0.7.3）

| 路径 | 是否消费/重置 `_buffer` | 对 Web 的影响 |
|---|---|---|
| `readBuffer()` | 是：命中标记时先 `_completeRunning` 再 `slice(marker.pos)` + `_cursor=0`；空闲时清空 | 显式路径，旧行为；Web 不读 `_buffer` |
| `_beginCapture()` | 是：`slice(marker.pos)` / `slice(_cursor)` + `_cursor=0`（每条新命令开始时的正常裁剪） | 无：Web 用 `_rawLog` 与 `_streamPos`，不依赖 `_buffer` |
| `_appendBuffer()` 超限裁剪 | 是：超过 2 MiB 从头部裁剪并平移 `_runningStartPos`/`_cursor`/`_streamPos` | 无直接消费；但超长运行输出快照可能只剩尾部窗口 |
| `_checkCompletion` / `_settleCompletion` / `_completeRunning` | 不切片，但 `_completeRunning` 写 history / 发 done / busy=false / `_streamPos=null` | 影响 Web 的是**事件**（cmdDone），这些路径本来就该发；peek 不触发 |
| `getRunningStream()` / `_streamPos` | 不改 `_buffer`，推进 `_streamPos` | Web transcript 的 `out` 增量来源；与 peek 无交互 |
| `readRawStream()` / `_rawLog` | 独立 ring，不改 `_buffer` | Web raw 的增量来源；完全独立 |
| `agent.pushStreams()` | 只调用 `readRawStream()` / `getRunningStream()` | 默认 read 改动不影响 Web |
| `doRead` 默认/显式 | 默认 busy 只调 `peekBuffer()`；`-s buffer` 仍调 `readBuffer()` | 默认路径不再触碰任何消费点 |

**结论**：Web 的 raw/transcript 数据来自 agent 的 `readRawStream`（`_rawLog`，独立 ring）与 `getRunningStream`（只推进 `_streamPos`），不依赖也不读取 `_buffer`；`peekBuffer()` 不触碰这两者。因此默认 read 改后**不会影响 Web**，无需额外修复。唯一需注意的既有边界是 `MAX_BUFFER_LEN` 裁剪：运行中输出超过 2 MiB 时，peek 与 `getRunningOutput` 一样只能看到尾部窗口。

## 测试

`test/peek-buffer.test.mjs`：

- 空闲/运行中多次 `peekBuffer`：buffer、cursor、streamPos、runningStartPos、busy、history 对数均不变
- 未连接返回错误且状态不变
- 显式 `readBuffer` 空闲时清空、命中完成标记时收尾并消费到标记位置
- `readBusyNotice` 仅在 busy=true 输出中英文前缀与警告
