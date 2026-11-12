# read 读取语义说明

## 背景

`term_cli read` 原先会把多条历史命令合并返回，调用方无法判断输出来自哪条命令；同时每次 read 末尾都会附加浏览器 URL，重复且混淆“工具信息”和“实际输出”。现在 read 只返回**当前/最后一条命令**的结果，并把工具元数据单独放首行。

## 行为

| 调用 | busy=false | busy=true |
|---|---|---|
| `read`（未传 `-s`） | 最后一条已完成命令的输出 | 先等 `timeoutMs`；完成返回结果，超时只返回状态信息（不读 buffer） |
| `read -s buffer` | 最后一条已完成命令（空闲时不再消费旧 buffer） | 先等 `timeoutMs`；完成后返回结果，超时才显式读 buffer |
| `read -s history` | 最后一条已完成命令的输出 | 先等 `timeoutMs`；完成返回结果，超时返回最后一条已完成命令 |

- `-l` / `--head` 仅为旧调用兼容保留，**不再选择多条历史**；默认永远只取最后一条命令。
- `-s buffer` 只用于 busy 时的实时缓冲；空闲时统一回退到最后一条已完成结果，避免把上一条命令回显/完成标记带出来。
- `read` busy 时默认等待 `exec.timeoutMs`（可用 `--timeout <ms>` 覆盖）；完成直接返回结果，超时只返回状态信息，不读 buffer；显式 `-s buffer` 才读缓冲。
- 没有结果时返回本地化的“暂时没有输出”，不返回空字符串。

## 输出格式

正常 idle 结果只返回 `<actual output>`，不显示工具元数据。

只有 busy/超时/错误时显示：

```text
[term_cli read] terminal=deps source=status state=busy

<actual output/snapshot>
```

- 不再追加浏览器 URL；浏览器地址只在 `term_cli status` 显示。
- `--includeCommand` 仍可在实际输出前加 `$ <command>` 行。

## 非消费保证（`peekBuffer()`）

有运行中命令时返回 `_runningStartPos` 之后的片段，否则返回整段缓冲。实现只做字符串切片，且切片在 `await toModelText` **之前**同步完成：

- 不改 `_buffer` / `_cursor` / `_streamPos` / `_runningStartPos` / `_runningCommand`
- 不调用 `_completeRunning`：不写 history、不发 done、不翻转 busy
- 只在未连接时返回 `ok:false`
- 展示处理：`_stripProbeEchoes` → `toModelText` → `_truncate`

## Web 影响

Web raw/transcript 来自 agent 的 `readRawStream`（独立 `_rawLog`）与 `getRunningStream`（推进 `_streamPos`），不依赖 `_buffer`；默认 read 的只读快照不影响 Web。唯一既有边界是 `MAX_BUFFER_LEN` 裁剪：运行中输出超过 2 MiB 时，快照只能看到尾部窗口。

## 测试

- `test/peek-buffer.test.mjs`：peek 多次读取不消费状态；显式 `readBuffer` 空闲/命中标记的旧消费语义；busy 通知文案。
- read 输出格式/最后一条命令的选择由 `src/read-output.ts` 的 `formatReadHeader`/`lastItem`/`formatReadResult` 覆盖；新增回归时断言首行元数据、空行、实际输出、无浏览器 URL。
