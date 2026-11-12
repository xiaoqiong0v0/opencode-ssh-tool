// waitForIdle：exec 默认同步与 status busy 轮询共用的等待策略
import test from "node:test"
import assert from "node:assert/strict"

import { waitForIdle } from "../dist/wait.js"

test("waitForIdle：已 idle 立即返回", async () => {
  const start = Date.now()
  await waitForIdle(() => false, 5000, 1000)
  assert.ok(Date.now() - start < 100)
})

test("waitForIdle：busy 转 idle 后返回，不等到 timeout", async () => {
  let calls = 0
  const start = Date.now()
  await waitForIdle(() => ++calls < 3, 500, 5)
  assert.ok(calls >= 3)
  assert.ok(Date.now() - start < 200)
})

test("waitForIdle：持续 busy 到 timeout 返回且不阻塞更久", async () => {
  const start = Date.now()
  await waitForIdle(() => true, 30, 5)
  const elapsed = Date.now() - start
  assert.ok(elapsed >= 25 && elapsed < 300, `elapsed=${elapsed}`)
})

test("waitForIdle：timeout=0 不等待", async () => {
  let calls = 0
  await waitForIdle(() => { calls += 1; return true }, 0, 1)
  assert.equal(calls, 1)
})
