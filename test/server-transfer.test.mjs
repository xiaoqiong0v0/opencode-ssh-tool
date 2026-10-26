// server 传输任务集成测试：ws 模拟 agent 上报 transfer + web 收广播/快照（不依赖真实 SSH）
import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WebSocket } from "ws"

import { startServer } from "../dist/server.js"

/** 等待 ws open */
function onceOpen(ws) {
  return new Promise((resolve, reject) => {
    ws.once("open", resolve)
    ws.once("error", reject)
  })
}

/** 等待满足条件的消息（忽略 ping 等无关消息） */
function waitMessage(ws, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error("timeout waiting for ws message"))
    }, timeoutMs)
    const onMessage = (raw) => {
      let msg
      try { msg = JSON.parse(raw.toString()) } catch { return }
      if (!predicate(msg)) return
      cleanup()
      resolve(msg)
    }
    const cleanup = () => {
      clearTimeout(timer)
      ws.off("message", onMessage)
    }
    ws.on("message", onMessage)
  })
}

/** 收集一段时间内的消息（用于断言"不应收到"） */
function collectMessages(ws) {
  const out = []
  const onMessage = (raw) => {
    try { out.push(JSON.parse(raw.toString())) } catch { /* 忽略非 JSON */ }
  }
  ws.on("message", onMessage)
  return { messages: out, stop: () => ws.off("message", onMessage) }
}

/** 构造合法任务 */
function task(overrides = {}) {
  return {
    id: "task-1",
    sessionID: "s1",
    name: "default",
    direction: "upload",
    localPath: "C:/tmp/a.txt",
    remotePath: "/home/u/a.txt",
    state: "running",
    bytes: 0,
    total: 12,
    startedAt: 1_700_000_000_000,
    ...overrides,
  }
}

test("server：agent 上报 transfer → web 收广播/subscribe 快照/list 快照；非法任务被丢弃", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ssh-tool-transfer-events-"))
  const server = await startServer(0, () => [], dir, "en")
  const wsUrl = server.url.replace(/^http/, "ws") + "/ws"
  const agent = new WebSocket(wsUrl)
  const web = new WebSocket(wsUrl)
  try {
    await Promise.all([onceOpen(agent), onceOpen(web)])

    // agent 注册（认领 s1/default）
    agent.send(JSON.stringify({ type: "register", sessions: [{ sessionID: "s1", name: "default" }], running: [] }))

    // list：无任务也必须回空数组
    web.send(JSON.stringify({ type: "list" }))
    const empty = await waitMessage(web, (m) => m.type === "transfers")
    assert.deepEqual(empty.tasks, [])

    // agent 上报 running 任务 → web 收到广播（任务不回发给 agent）
    const agentSeen = collectMessages(agent)
    const broadcastPromise = waitMessage(web, (m) => m.type === "transfer" && m.task?.id === "task-1")
    agent.send(JSON.stringify({ type: "transfer", task: task() }))
    const broadcast = await broadcastPromise
    assert.equal(broadcast.task.state, "running")
    assert.equal(broadcast.task.total, 12)

    // subscribe：回该 session/name 的任务快照
    const subPromise = waitMessage(web, (m) => m.type === "transfers" && Array.isArray(m.tasks) && m.tasks.length === 1)
    web.send(JSON.stringify({ type: "subscribe", sessionID: "s1", name: "default" }))
    const sub = await subPromise
    assert.equal(sub.tasks[0].id, "task-1")

    // 完成更新 → 再次广播 done
    const donePromise = waitMessage(web, (m) => m.type === "transfer" && m.task?.state === "done")
    agent.send(JSON.stringify({ type: "transfer", task: task({ state: "done", bytes: 12, endedAt: 1_700_000_001_000 }) }))
    const done = await donePromise
    assert.equal(done.task.bytes, 12)

    // 非法任务（未知 direction）被服务端丢弃：不广播、不进快照
    agent.send(JSON.stringify({ type: "transfer", task: task({ id: "bad-task", direction: "move" }) }))
    // web 伪造的 transfer 也应被忽略（web 未注册为 agent）
    web.send(JSON.stringify({ type: "transfer", task: task({ id: "web-forged" }) }))
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(agentSeen.messages.some((m) => m.type === "transfer"), false, "任务不得回发给 agent")

    web.send(JSON.stringify({ type: "list" }))
    const snapshot = await waitMessage(web, (m) => m.type === "transfers" && m.tasks.some((t) => t.id === "task-1"))
    assert.deepEqual(snapshot.tasks.map((t) => t.id), ["task-1"], "非法/伪造任务不得进入快照")
    agentSeen.stop()
  } finally {
    agent.close()
    web.close()
    server.close()
    // 等 ws close 事件触发的状态推送去抖（STATUS_PUSH_DEBOUNCE_MS）落完，再删临时目录
    await new Promise((r) => setTimeout(r, 250))
    await rm(dir, { recursive: true, force: true })
  }
})

test("server：list 快照 scope=all；subscribe 按 sessionID+name 只返回该终端任务", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ssh-tool-transfer-scope-"))
  const server = await startServer(0, () => [], dir, "en")
  const wsUrl = server.url.replace(/^http/, "ws") + "/ws"
  const agent = new WebSocket(wsUrl)
  const web = new WebSocket(wsUrl)
  try {
    await Promise.all([onceOpen(agent), onceOpen(web)])
    agent.send(JSON.stringify({ type: "register", sessions: [{ sessionID: "s1", name: "default" }, { sessionID: "s1", name: "db" }], running: [] }))

    agent.send(JSON.stringify({ type: "transfer", task: task({ id: "a", name: "default" }) }))
    agent.send(JSON.stringify({ type: "transfer", task: task({ id: "b", name: "db" }) }))
    agent.send(JSON.stringify({ type: "transfer", task: task({ id: "c", sessionID: "s2", name: "default" }) }))
    web.send(JSON.stringify({ type: "list" }))
    const all = await waitMessage(web, (m) => m.type === "transfers" && m.scope === "all" && m.tasks.length === 3)
    assert.deepEqual(all.tasks.map((t) => t.id).sort(), ["a", "b", "c"], "scope=all 必须是全量快照")

    // subscribe 带 name=default：只返回该终端任务（终端级，不再返回会话全部终端）
    web.send(JSON.stringify({ type: "subscribe", sessionID: "s1", name: "default" }))
    const byDefault = await waitMessage(web, (m) => m.type === "transfers" && m.sessionID === "s1" && m.name === "default")
    assert.deepEqual(byDefault.tasks.map((t) => t.id), ["a"], "subscribe 必须只返回该终端任务")

    // 同一会话换终端订阅：列表随之切换（db 只见 db，不得混入 default/其他会话）
    web.send(JSON.stringify({ type: "subscribe", sessionID: "s1", name: "db" }))
    const byDb = await waitMessage(web, (m) => m.type === "transfers" && m.sessionID === "s1" && m.name === "db")
    assert.deepEqual(byDb.tasks.map((t) => t.id), ["b"], "切换终端后快照只含该终端任务")
  } finally {
    agent.close()
    web.close()
    server.close()
    await new Promise((r) => setTimeout(r, 250))
    await rm(dir, { recursive: true, force: true })
  }
})

test("server：agent 断开 → 该 agent 认领终端的 running 任务标记 failed 并广播；其他 agent 任务不受影响", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ssh-tool-transfer-disconnect-"))
  const server = await startServer(0, () => [], dir, "en")
  const wsUrl = server.url.replace(/^http/, "ws") + "/ws"
  const agentA = new WebSocket(wsUrl)
  const agentB = new WebSocket(wsUrl)
  const web = new WebSocket(wsUrl)
  try {
    await Promise.all([onceOpen(agentA), onceOpen(agentB), onceOpen(web)])
    // 两个 agent 各认领同一会话的不同终端
    agentA.send(JSON.stringify({ type: "register", sessions: [{ sessionID: "s1", name: "default" }], running: [] }))
    agentB.send(JSON.stringify({ type: "register", sessions: [{ sessionID: "s1", name: "db" }], running: [] }))

    const aRunning = waitMessage(web, (m) => m.type === "transfer" && m.task?.id === "a")
    const bRunning = waitMessage(web, (m) => m.type === "transfer" && m.task?.id === "b")
    agentA.send(JSON.stringify({ type: "transfer", task: task({ id: "a", name: "default" }) }))
    agentB.send(JSON.stringify({ type: "transfer", task: task({ id: "b", name: "db" }) }))
    await Promise.all([aRunning, bRunning])

    // agent A 断开：其认领的 s1/default 上 running 任务必须收尾为 failed
    const seen = collectMessages(web)
    const failedPromise = waitMessage(web, (m) => m.type === "transfer" && m.task?.id === "a" && m.task.state === "failed")
    agentA.close()
    const failed = await failedPromise
    assert.equal(failed.task.errorCode, "agent_disconnected")
    assert.equal(typeof failed.task.endedAt, "number")

    // 其他 agent 认领的终端任务不得被连带标记
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(
      seen.messages.some((m) => m.type === "transfer" && m.task?.id === "b" && m.task.state === "failed"),
      false,
      "其他 agent 的 running 任务不得被标记 failed",
    )
    seen.stop()

    // 快照同源：a=failed、b 仍 running
    web.send(JSON.stringify({ type: "list" }))
    const snapshot = await waitMessage(web, (m) => m.type === "transfers" && m.scope === "all")
    const byId = new Map(snapshot.tasks.map((t) => [t.id, t]))
    assert.equal(byId.get("a")?.state, "failed")
    assert.equal(byId.get("b")?.state, "running")
  } finally {
    agentA.close()
    agentB.close()
    web.close()
    server.close()
    await new Promise((r) => setTimeout(r, 250))
    await rm(dir, { recursive: true, force: true })
  }
})
