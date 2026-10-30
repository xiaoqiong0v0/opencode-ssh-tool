// server raw 重连回归：新代次的空 rawBuf 必须清屏，不能回退旧 history 后再拼接新输出
import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WebSocket } from "ws"

import { startServer } from "../dist/server.js"

const SID = "s1"
const NAME = "deps"

function onceOpen(ws) {
  return new Promise((resolve, reject) => {
    ws.once("open", resolve)
    ws.once("error", reject)
  })
}

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

test("server：同名会话重建后 raw 空基线不得回退旧 history，新输出不能接在旧内容后", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ssh-tool-raw-reconnect-"))
  const histDir = join(dir, SID, NAME)
  await mkdir(histDir, { recursive: true })
  await writeFile(
    join(histDir, "000001-1700000000000.json"),
    JSON.stringify({
      command: "mvn -pl old-project compile",
      output: "old output\r\n",
      ts: 1_700_000_000_000,
      endTs: 1_700_000_001_000,
      exitCode: 0,
    }),
    "utf8",
  )

  const server = await startServer(0, () => [], dir, "en")
  const wsUrl = server.url.replace(/^http/, "ws") + "/ws"
  const agent = new WebSocket(wsUrl)
  const web = new WebSocket(wsUrl)
  const web2 = new WebSocket(wsUrl)
  try {
    await Promise.all([onceOpen(agent), onceOpen(web), onceOpen(web2)])
    agent.send(JSON.stringify({ type: "register", sessions: [{ sessionID: SID, name: NAME }], running: [] }))

    // 新代次建立空 raw 基线：服务端必须保留这个“空”状态，而不是把它当成无实时流。
    agent.send(JSON.stringify({
      type: "raw",
      sessionID: SID,
      name: NAME,
      data: "",
      pos: 0,
      reset: true,
      generation: "new-generation",
    }))

    web.send(JSON.stringify({ type: "subscribe", sessionID: SID, name: NAME, mode: "raw" }))
    const baseline = await waitMessage(web, (m) => m.type === "raw")
    assert.equal(baseline.reset, true)
    assert.equal(baseline.data, "", "新代次空基线不能回退到旧 history")

    const next = waitMessage(web, (m) => m.type === "raw" && m.reset === false)
    agent.send(JSON.stringify({
      type: "raw",
      sessionID: SID,
      name: NAME,
      data: "PS D:\\python-project> ",
      pos: 22,
      reset: false,
      generation: "new-generation",
    }))
    const out = await next
    assert.equal(out.data, "PS D:\\python-project> ", "新输出只能从空基线开始")

    // 第二个订阅者看到的是“空基线 + 新增量”的 rawBuf，而不是旧 history + 新增量。
    web2.send(JSON.stringify({ type: "subscribe", sessionID: SID, name: NAME, mode: "raw" }))
    const rebound = await waitMessage(web2, (m) => m.type === "raw")
    assert.equal(rebound.reset, true)
    assert.equal(rebound.data, "PS D:\\python-project> ", "rawBuf 不得包含旧 history")
  } finally {
    agent.close()
    web.close()
    web2.close()
    server.close()
    await new Promise((r) => setTimeout(r, 250))
    await rm(dir, { recursive: true, force: true })
  }
})
