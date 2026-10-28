// peekBuffer 只读语义 / 显式 readBuffer 旧消费语义 / busy 提示文案的单测（不依赖网络与真实终端）
import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { SshSession } from "../dist/session.js"
import { SessionHistory } from "../dist/history.js"
import { readBusyNotice } from "../dist/read-output.js"

/**
 * 建一个最小 SshSession（只操作内存态，不建连接）
 * @returns {{ session: SshSession, cleanup: () => void, history: SessionHistory }}
 */
function makeSession() {
  const root = mkdtempSync(join(tmpdir(), "ssh-peek-"))
  const history = new SessionHistory(root, "sess", 10)
  const session = new SshSession("sess", history, "default", "en")
  return { session, history, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/**
 * 记录会被消费路径改动的状态快照
 * @param session 会话
 * @param history 历史
 * @returns 状态快照
 */
function snapshot(session, history) {
  return {
    buffer: session._buffer,
    cursor: session._cursor,
    streamPos: session._streamPos,
    runningStartPos: session._runningStartPos,
    runningCommand: session._runningCommand,
    busy: session.getStatus().busy,
    pairs: history.totalPairs(),
  }
}

test("peekBuffer 空闲时返回整个 buffer，多次读取不消费任何状态", async (t) => {
  const { session, history, cleanup } = makeSession()
  t.after(cleanup)
  session._connected = true
  session._buffer = "hello\r\nworld"
  session._cursor = 4
  session._streamPos = 2
  session._remoteBusy = true
  const before = snapshot(session, history)

  const first = await session.peekBuffer()
  const second = await session.peekBuffer()

  assert.equal(first.ok, true)
  assert.equal(first.output, "hello\nworld")
  assert.equal(second.output, first.output)
  assert.deepEqual(snapshot(session, history), before)
})

test("peekBuffer 运行中只返回 _runningStartPos 之后，且不改 busy/stream/history", async (t) => {
  const { session, history, cleanup } = makeSession()
  t.after(cleanup)
  session._connected = true
  session._buffer = "abc$ echo hi\nout-data"
  session._runningStartPos = 5
  session._runningCommand = "echo hi"
  session._runningSeq = 3
  session._cursor = 3
  session._streamPos = 7
  session._remoteBusy = true
  const before = snapshot(session, history)

  const r = await session.peekBuffer()

  assert.equal(r.ok, true)
  assert.match(r.output, /echo hi/)
  assert.match(r.output, /out-data/)
  assert.doesNotMatch(r.output, /abc\$/)
  assert.deepEqual(snapshot(session, history), before)
  assert.equal(session.getStatus().busy, true)
  assert.equal(history.totalPairs(), 0)
})

test("peekBuffer 未连接返回错误且不修改状态", async (t) => {
  const { session, history, cleanup } = makeSession()
  t.after(cleanup)
  session._connected = false
  session._buffer = "leftover"
  session._cursor = 2
  const before = snapshot(session, history)

  const r = await session.peekBuffer()

  assert.equal(r.ok, false)
  assert.ok(r.error)
  assert.deepEqual(snapshot(session, history), before)
})

test("显式 readBuffer 空闲时仍消费：返回后清空 buffer 且 cursor 归零", async (t) => {
  const { session, history, cleanup } = makeSession()
  t.after(cleanup)
  session._connected = true
  session._buffer = "abc\n"
  session._cursor = 2

  const r = await session.readBuffer()

  assert.equal(r.ok, true)
  assert.equal(r.output, "abc")
  assert.equal(session._buffer, "")
  assert.equal(session._cursor, 0)
  assert.equal(history.totalPairs(), 0)
})

test("显式 readBuffer 命中完成标记时按旧语义收尾并消费到标记位置", async (t) => {
  const { session, history, cleanup } = makeSession()
  t.after(cleanup)
  session._connected = true
  session._remoteBusy = true
  session._runningStartPos = 0
  session._runningCommand = "echo hi"
  session._runningSeq = 1
  session._buffer = `$ echo hi\nout\n<SSH_DONE:${session.nonce}:1:0>`

  const r = await session.readBuffer()

  assert.equal(r.ok, true)
  assert.match(r.output, /out/)
  assert.equal(session._buffer, "")
  assert.equal(session._cursor, 0)
  assert.equal(session.getStatus().busy, false)
  assert.equal(history.totalPairs(), 1)
  assert.equal(history.getPairs()[0].command, "echo hi")
})

test("readBusyNotice 只在 busy=true 时返回前缀+警告", () => {
  assert.equal(readBusyNotice("buffer", false, "en"), "")
  assert.equal(readBusyNotice("history", false, "zh"), "")

  const bufEn = readBusyNotice("buffer", true, "en")
  assert.ok(bufEn.startsWith("[read source=buffer busy=true]"))
  assert.match(bufEn, /partial buffer snapshot/)
  assert.match(bufEn, /not the final result/)

  const histEn = readBusyNotice("history", true, "en")
  assert.ok(histEn.startsWith("[read source=history busy=true]"))
  assert.match(histEn, /only contains completed commands/)

  const bufZh = readBusyNotice("buffer", true, "zh")
  assert.ok(bufZh.startsWith("[read source=buffer busy=true]"))
  assert.match(bufZh, /部分快照/)

  const histZh = readBusyNotice("history", true, "zh")
  assert.ok(histZh.startsWith("[read source=history busy=true]"))
  assert.match(histZh, /不含当前结果/)
})
