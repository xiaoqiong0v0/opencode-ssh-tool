// 传输任务事件协议单测：parseTransferTask 只接受合法元数据，拒绝未知方向/状态与超长字段
import test from "node:test"
import assert from "node:assert/strict"

import { parseTransferTask } from "../dist/transfer-events.js"
import { TRANSFER_TASK_PATH_MAX } from "../dist/constants.js"

/** 合法任务样例 */
function validTask(overrides = {}) {
  return {
    id: "task-1",
    sessionID: "ses_abc",
    name: "default",
    direction: "upload",
    localPath: "C:/tmp/a.txt",
    remotePath: "/home/u/a.txt",
    state: "running",
    bytes: 3,
    total: 10,
    startedAt: 1_700_000_000_000,
    ...overrides,
  }
}

test("parseTransferTask：合法 running 任务通过，endedAt/errorCode 可缺省", () => {
  const task = parseTransferTask(validTask())
  assert.ok(task)
  assert.equal(task.id, "task-1")
  assert.equal(task.direction, "upload")
  assert.equal(task.state, "running")
  assert.equal(task.endedAt, undefined)
  assert.equal(task.errorCode, undefined)
})

test("parseTransferTask：done/failed 的 endedAt/errorCode 保留", () => {
  const done = parseTransferTask(validTask({ state: "done", endedAt: 1_700_000_001_000 }))
  assert.ok(done)
  assert.equal(done.state, "done")
  assert.equal(done.endedAt, 1_700_000_001_000)

  const failed = parseTransferTask(validTask({ state: "failed", endedAt: 1_700_000_002_000, errorCode: "timeout" }))
  assert.ok(failed)
  assert.equal(failed.state, "failed")
  assert.equal(failed.errorCode, "timeout")
})

test("parseTransferTask：只保留白名单字段（未知字段/文件内容不被透传）", () => {
  const task = parseTransferTask(validTask({ content: "SECRET-FILE-BODY", extra: { a: 1 } }))
  assert.ok(task)
  assert.deepEqual(Object.keys(task).sort(), [
    "bytes",
    "direction",
    "id",
    "localPath",
    "name",
    "remotePath",
    "sessionID",
    "startedAt",
    "state",
    "total",
  ])
  assert.equal("content" in task, false)
  assert.equal(JSON.stringify(task).includes("SECRET-FILE-BODY"), false)
})

test("parseTransferTask：缺字段 / 非法 direction / 非法 state 全部拒绝", () => {
  // 缺少每个必填字段都应为 null
  for (const key of ["id", "sessionID", "name", "direction", "localPath", "remotePath", "state", "bytes", "total", "startedAt"]) {
    const broken = validTask()
    delete broken[key]
    assert.equal(parseTransferTask(broken), null, `缺少 ${key} 必须拒绝`)
  }
  assert.equal(parseTransferTask(validTask({ direction: "move" })), null)
  assert.equal(parseTransferTask(validTask({ direction: 1 })), null)
  assert.equal(parseTransferTask(validTask({ state: "paused" })), null)
  assert.equal(parseTransferTask(validTask({ state: null })), null)
})

test("parseTransferTask：类型/长度/数值边界拒绝", () => {
  assert.equal(parseTransferTask(null), null)
  assert.equal(parseTransferTask([]), null)
  assert.equal(parseTransferTask("task"), null)

  assert.equal(parseTransferTask(validTask({ id: "" })), null)
  assert.equal(parseTransferTask(validTask({ name: 123 })), null)
  assert.equal(parseTransferTask(validTask({ localPath: "" })), null)
  assert.equal(parseTransferTask(validTask({ localPath: "x".repeat(TRANSFER_TASK_PATH_MAX + 1) })), null)
  assert.equal(parseTransferTask(validTask({ remotePath: "x".repeat(TRANSFER_TASK_PATH_MAX + 1) })), null)
  assert.equal(parseTransferTask(validTask({ bytes: -1 })), null)
  assert.equal(parseTransferTask(validTask({ bytes: 1.5 })), null)
  assert.equal(parseTransferTask(validTask({ total: Number.NaN })), null)
  assert.equal(parseTransferTask(validTask({ startedAt: -1 })), null)
  assert.equal(parseTransferTask(validTask({ endedAt: "now" })), null)
  assert.equal(parseTransferTask(validTask({ errorCode: 7 })), null)
})
