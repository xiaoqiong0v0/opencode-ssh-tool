import { createServer, type Server, type IncomingMessage } from "node:http"
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join, dirname, extname, normalize } from "node:path"
import { fileURLToPath } from "node:url"
import type { AddressInfo } from "node:net"
import { WebSocketServer, WebSocket } from "ws"
import { listAllSessions, removeSessionState } from "./session-store.js"
import { tr, type FlatKey, type Lang } from "./i18n.js"
import { PTY_COLS } from "./constants.js"
import type { SessionHistory } from "./history.js"
import log from "./log.js"

export interface LiveSession {
  getHistory(): SessionHistory
  getRunningOutput(): string
  getRunningCommand(): string
  hasRunningStream(): boolean
  getRunningStream(): { data: string; done: boolean }
  close(): void
  readRawStream(pos: number): { data: string; pos: number; reset?: boolean }
}

export interface ServerHandle {
  server: Server
  port: number
  url: string
  close(): void
}

export interface SessionEntry {
  sessionID: string
  name: string
  session: LiveSession
  kind?: "ssh" | "local"
  title?: string
  directory?: string
}

interface WsClient extends WebSocket {
  _sub?: { sid: string; name: string }
  _lastKey?: string
  _forceSnap?: boolean
  _snapBase?: number
  _wasRunning?: boolean
  _lastSessionsJson?: string
  _rawPos?: number
  _agentId?: string
  _regSessions?: Set<string>
  /** 代理 buf 流的消费游标（独立进程模式，按字节跟踪已推给客户端的量） */
  _bufPos?: number
  /** 本次命令是否已发过 runEnd（done 转变只发一次，新命令开始重置） */
  _sentDone?: boolean
}

export interface TranscriptPair {
  type: "cmd" | "out" | "run" | "sep"
  ts?: number
  endTs?: number
  text: string
}

const PAGE_KEYS: FlatKey[] = [
  "web_title",
  "web_loading",
  "web_time",
  "web_new_messages",
  "web_terminals",
  "web_local",
  "web_delete_terminal",
  "web_cmd_placeholder",
  "web_send_ctrlc",
]

const JS_I18N_KEYS: Record<string, FlatKey> = {
  run: "web_running",
  commands: "web_commands",
  autoRefresh: "web_auto_refresh",
  sessionGone: "web_session_gone",
  noSession: "web_no_session",
  loadFailed: "web_load_failed",
  local: "web_local",
  terminals: "web_terminals",
  cmdPlaceholder: "web_cmd_placeholder",
  sendCtrlC: "web_send_ctrlc",
}

const SNAP_STABLE_MS = 400
const STATUS_PUSH_MS = 2000

const sessionKey = (sid: string, name: string): string => `${sid}:${name}`

export function startServer(
  port: number,
  getSessions: () => SessionEntry[],
  dir: string,
  lang: Lang = "en",
  streamTickMs = 100,
): Promise<ServerHandle> {
  let actualPort = port
  const webDir = join(dirname(fileURLToPath(import.meta.url)), "web")
  const pageTemplate = readTemplate(webDir)

  const agents = new Map<WsClient, Set<string>>()
  const agentBySession = new Map<string, WsClient>()
  const streamBuf = new Map<string, { data: string; done: boolean; ts: number }>()
  const rawBuf = new Map<string, { data: string; pos: number }>()
  const BUSY_TIMEOUT = 30000 // 30s 无推流更新自动清 busy

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    const path = url.pathname

    if (path === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    if (path === "/") {
      const html = renderPage(lang, pageTemplate)
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      res.end(html)
      return
    }

    if (path.startsWith("/web/")) {
      serveStatic(res, webDir, decodeURIComponent(path.slice("/web/".length)))
      return
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
    res.end("Not Found")
  })

  const wss = new WebSocketServer({ noServer: true })
  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if (url.pathname !== "/ws") { socket.destroy(); return }
    wss.handleUpgrade(req, socket, head, (ws) => { wss.emit("connection", ws, req) })
  })

  const send = (ws: WsClient, msg: unknown): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  const buildSessions = (): Record<string, unknown> => {
    const states = listAllSessions(dir)
    const liveKey = new Set(agentBySession.keys())
    const liveBusy = new Map<string, boolean>()
    const now = Date.now()
    for (const [key] of agentBySession) {
      const b = streamBuf.get(key)
      // 超过 30s 无更新且未完成则自动清为 done（防止 agent 推流竞争导致 busy 卡死）
      if (b && !b.done && now - b.ts > BUSY_TIMEOUT) { b.done = true; b.ts = now }
      liveBusy.set(key, !!b && !b.done)
    }
    for (const s of states) {
      if (s.connected && !liveKey.has(sessionKey(s.sessionID, s.name))) {
        s.connected = false
      }
      const lk = sessionKey(s.sessionID, s.name)
      const busy = liveBusy.get(lk)
      if (busy !== undefined) s.busy = busy
    }
    const bySession = new Map<string, { title?: string; directory?: string; terminals: { name: string; kind?: string; host?: string; user?: string; port?: number; program?: string; connected: boolean; busy: boolean; pending: number }[] }>()
    for (const s of states) {
      if (!bySession.has(s.sessionID)) bySession.set(s.sessionID, { title: s.title, directory: s.directory, terminals: [] })
      bySession.get(s.sessionID)!.terminals.push({ name: s.name, kind: s.kind, host: s.host, user: s.user, port: s.port, program: s.program, connected: s.connected, busy: s.busy, pending: s.pending })
    }
    const sessions = [...bySession.entries()].map(([sessionID, v]) => ({ sessionID, title: v.title, directory: v.directory, terminals: v.terminals }))
    return { port: actualPort, sessions }
  }

  const buildSnapshot = (sid: string, name: string, entry?: SessionEntry): { pairs: TranscriptPair[]; notFound?: boolean } => {
    if (entry) {
      const pairs: TranscriptPair[] = []
      for (const pair of entry.session.getHistory().getPairs()) {
        if (pair.command === "__SSH_SEP__") {
          pairs.push({ type: "sep", ts: pair.ts, text: "" })
        } else {
          pairs.push({ type: "cmd", ts: pair.ts, endTs: pair.endTs, text: pair.command })
          pairs.push({ type: "out", text: entry.session.getHistory().readOutput(pair) })
        }
      }
      if (entry.session.hasRunningStream()) {
        const runningCmd = entry.session.getRunningCommand()
        if (runningCmd) pairs.push({ type: "cmd", ts: Date.now(), text: runningCmd })
        const running = entry.session.getRunningOutput()
        if (running) pairs.push({ type: "run", text: running })
      }
      return { pairs }
    }
    const state = listAllSessions(dir).find((s) => s.sessionID === sid && s.name === name)
    const histName = state?.kind === "local" ? `local-${name}` : name
    const pairs = readHistoryFromFile(dir, sid, histName) ?? []
    const sKey = sessionKey(sid, name)
    const buf = streamBuf.get(sKey)
    if (buf && !buf.done) {
      if (pairs.length > 0 && pairs[pairs.length - 1].type !== "cmd" && pairs[pairs.length - 1].type !== "sep") {
        const last = pairs[pairs.length - 1]
        if (last.type === "run") pairs.push({ type: "cmd", ts: Date.now(), text: "" })
      }
      if (buf.data) pairs.push({ type: "run", text: buf.data })
    }
    if (pairs.length === 0 && !state) return { pairs: [], notFound: true }
    return { pairs }
  }

  const historyKey = (session: LiveSession): string => {
    const hp = session.getHistory().getPairs()
    const last = hp[hp.length - 1]
    return `${hp.length}:${last ? `${last.seq}:${last.size}` : "-"}`
  }

  const streamTimer = setInterval(() => {
    for (const client of wss.clients as Set<WsClient>) {
      if (client.readyState !== WebSocket.OPEN) continue
      const sub = client._sub
      if (!sub) continue
      const entry = getSessions().find((e) => e.sessionID === sub.sid && e.name === sub.name)
      const session = entry?.session
      const sKey = sessionKey(sub.sid, sub.name)
      const buf = streamBuf.get(sKey)

      if (!session && !buf) {
        const snap = buildSnapshot(sub.sid, sub.name)
        const key = JSON.stringify(snap)
        if (key !== client._lastKey) {
          client._lastKey = key
          send(client, { type: "snapshot", sessionID: sub.sid, name: sub.name, ...snap })
        }
        if (client._rawPos !== undefined) client._rawPos = undefined
        continue
      }

      if (session) {
        const runActive = session.hasRunningStream()
        if (runActive && !client._wasRunning) {
          const cmd = session.getRunningCommand()
          if (cmd) send(client, { type: "cmdStart", command: cmd })
        }
        client._wasRunning = runActive
        const st = session.getRunningStream()
        if (st.done) {
          if (!client._forceSnap) { send(client, { type: "runEnd" }); client._forceSnap = true; client._snapBase = Date.now() }
        } else if (st.data) { send(client, { type: "run", data: st.data }) }
        const key = historyKey(session)
        const forceDone = client._forceSnap && (!runActive || (client._snapBase ?? 0) > 0 && Date.now() - client._snapBase! >= SNAP_STABLE_MS)
        if (forceDone || (!runActive && key !== client._lastKey)) {
          client._forceSnap = false; client._lastKey = key
          send(client, { type: "snapshot", sessionID: sub.sid, name: sub.name, ...buildSnapshot(sub.sid, sub.name, entry) })
        }
        if (client._rawPos !== undefined) {
          const r = session.readRawStream(client._rawPos)
          if (r.data) { client._rawPos = r.pos; send(client, { type: "raw", data: r.data, pos: r.pos, reset: !!r.reset }) }
        }
        continue
      }

      if (buf) {
        const newData = client._bufPos !== undefined ? buf.data.slice(client._bufPos) : buf.data
        client._bufPos = buf.data.length
        if (newData) send(client, { type: "run", data: newData })
        // done 转变：只发一次 runEnd（新命令开始时在 stream {command} 处理里重置 _sentDone）
        if (buf.done && !client._sentDone) {
          client._sentDone = true
          send(client, { type: "runEnd" })
          client._forceSnap = true
          client._snapBase = Date.now()
        }
        if (client._forceSnap && Date.now() - (client._snapBase ?? 0) >= SNAP_STABLE_MS) {
          client._forceSnap = false
          const snap = buildSnapshot(sub.sid, sub.name)
          const key = JSON.stringify(snap)
          if (key !== client._lastKey) {
            client._lastKey = key
            if (client._rawPos !== undefined) {
              // raw 模式：不推 pairs 全量，仅发轻量命令计数
              send(client, { type: "meta", sessionID: sub.sid, name: sub.name, commands: snap.pairs.filter((p) => p.type === "cmd").length })
            } else {
              send(client, { type: "snapshot", sessionID: sub.sid, name: sub.name, ...snap })
            }
          }
        }
        if (client._rawPos !== undefined) {
          const r = rawBuf.get(sKey)
          if (r && r.pos > client._rawPos) {
            const data = r.data.slice(client._rawPos)
            if (data) { client._rawPos = r.pos; send(client, { type: "raw", data, pos: r.pos }) }
          }
        }
      }
    }
  }, streamTickMs)

  const statusTimer = setInterval(() => {
    const payload = buildSessions()
    const json = JSON.stringify(payload)
    for (const client of wss.clients as Set<WsClient>) {
      if (client.readyState !== WebSocket.OPEN) continue
      if (json === client._lastSessionsJson) continue
      client._lastSessionsJson = json
      send(client, { type: "sessions", ...payload })
    }
  }, STATUS_PUSH_MS)

  wss.on("connection", (ws: WsClient) => {
    ws.on("message", (raw) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(raw.toString()) } catch { return }
      const t = msg.type as string | undefined
      if (!t) return

      if (t === "register") {
        const sessions = msg.sessions as Array<{ sessionID: string; name: string }> | undefined
        if (!Array.isArray(sessions)) return
        for (const old of agents.get(ws) ?? []) agentBySession.delete(old)
        agents.set(ws, new Set())
        for (const s of sessions) {
          const k = sessionKey(s.sessionID, s.name)
          agents.get(ws)!.add(k)
          agentBySession.set(k, ws)
        }
        return
      }

      if (t === "stream") {
        const sid = typeof msg.sessionID === "string" ? msg.sessionID : ""
        const name = typeof msg.name === "string" ? msg.name : ""
        if (!sid) return
        const k = sessionKey(sid, name)
        const data = typeof msg.data === "string" ? msg.data : ""
        const done = msg.done === true
        const command = typeof msg.command === "string" ? msg.command : ""
        const existing = streamBuf.get(k)
        if (command) {
          // 新执行开始（无论是否已有 entry）：重置数据+游标+通知前端
          // 但保留已有 done=true（防止 stream {command} 后于 done 消息到达把 done 踩回 false）
          const wasDone = existing && existing.done
          streamBuf.set(k, { data, done: done || !!wasDone, ts: Date.now() })
          for (const c of wss.clients as Set<WsClient>) {
            if (c.readyState !== WebSocket.OPEN || !c._sub || c._sub.sid !== sid || c._sub.name !== name) continue
            c._bufPos = 0
            c._sentDone = false
            c._forceSnap = false
            c._snapBase = 0
            send(c, { type: "cmdStart", command })
          }
        } else if (existing && done) { existing.done = true; existing.ts = Date.now(); if (data) existing.data = (existing.data || "") + data }
        else if (existing && !done) { existing.ts = Date.now(); if (data) existing.data = (existing.data || "") + data }
        else { streamBuf.set(k, { data, done, ts: Date.now() }) }
        return
      }

      if (t === "done" || t === "result") {
        const sid = typeof msg.sessionID === "string" ? msg.sessionID : ""
        const name = typeof msg.name === "string" ? msg.name : ""
        if (sid) {
          const k = sessionKey(sid, name)
          const b = streamBuf.get(k)
          if (b) { b.done = true; b.ts = Date.now() }
        }
        const payload = buildSessions()
        const json = JSON.stringify(payload)
        for (const client of wss.clients as Set<WsClient>) {
          if (client.readyState !== WebSocket.OPEN) continue
          client._forceSnap = true
          client._snapBase = Date.now()
          client._lastSessionsJson = json
          send(client, { type: "sessions", ...payload })
        }
        return
      }

      // --- 以下 web 客户端消息 ---

      if (t === "raw") {
        const sid = typeof msg.sessionID === "string" ? msg.sessionID : ""
        const name = typeof msg.name === "string" ? msg.name : ""
        const data = typeof msg.data === "string" ? msg.data : ""
        const pos = typeof msg.pos === "number" ? msg.pos : 0
        if (!sid) return
        const k = sessionKey(sid, name)
        const existing = rawBuf.get(k)
        if (msg.reset === true || !existing) rawBuf.set(k, { data, pos })
        else if (data) rawBuf.set(k, { data: existing.data + data, pos })
        return
      }

      if (t === "subscribe") {
        const sid = typeof msg.sessionID === "string" ? msg.sessionID : ""
        const name = typeof msg.name === "string" ? msg.name : ""
        if (!sid) return
        const entry = getSessions().find((e) => e.sessionID === sid && e.name === name)
        const snap = buildSnapshot(sid, name, entry)
        ws._sub = { sid, name }
        ws._lastKey = JSON.stringify(snap)
        ws._forceSnap = false
        const wantRaw = msg.raw === true
        if (!wantRaw) {
          // 非 raw：发完整 snapshot（renderTranscript 依赖 pairs）
          send(ws, { type: "snapshot", sessionID: sid, name, ...snap })
        } else if (snap.notFound) {
          // raw 但会话不存在：仍需发 notFound 提示
          send(ws, { type: "snapshot", sessionID: sid, name, ...snap })
        } else {
          // raw：raw 连续流已含完整画面，不重发 pairs 全量，只发轻量命令计数
          const cmdCount = snap.pairs.filter((p) => p.type === "cmd").length
          send(ws, { type: "meta", sessionID: sid, name, commands: cmdCount })
        }
        if (wantRaw) {
          if (entry) {
            const r = entry.session.readRawStream(0)
            ws._rawPos = r.pos
            send(ws, { type: "raw", data: r.data, pos: r.pos, reset: true })
          } else if (agentBySession.has(sessionKey(sid, name))) {
            const r = rawBuf.get(sessionKey(sid, name))
            ws._rawPos = r?.pos ?? 0
            if (r?.data) send(ws, { type: "raw", data: r.data, pos: r.pos, reset: true })
          } else { ws._rawPos = 0 }
        } else { ws._rawPos = undefined }
        return
      }

      if (t === "setRaw") {
        // Raw 开关切换：不重新订阅（避免重发 snapshot），只切换 raw 推流
        if (!ws._sub) return
        const on = msg.on === true
        if (!on) {
          ws._rawPos = undefined
          // 关 raw：raw 期间未推 snapshot，补发完整 pairs（renderTranscript 需渲染）
          const { sid: s2, name: n2 } = ws._sub
          const entry = getSessions().find((e) => e.sessionID === s2 && e.name === n2)
          const snap = buildSnapshot(s2, n2, entry)
          ws._lastKey = JSON.stringify(snap)
          send(ws, { type: "snapshot", sessionID: s2, name: n2, ...snap })
          return
        }
        // 开 raw：清空历史画面，从当前 raw 全量重放
        const { sid: s2, name: n2 } = ws._sub
        const entry = getSessions().find((e) => e.sessionID === s2 && e.name === n2)
        if (entry) {
          const r = entry.session.readRawStream(0)
          ws._rawPos = r.pos
          send(ws, { type: "raw", data: r.data, pos: r.pos, reset: true })
        } else if (agentBySession.has(sessionKey(s2, n2))) {
          const r = rawBuf.get(sessionKey(s2, n2))
          ws._rawPos = r?.pos ?? 0
          if (r?.data) send(ws, { type: "raw", data: r.data, pos: r.pos, reset: true })
        } else { ws._rawPos = 0 }
        return
      }

      if (t === "unsubscribe") { ws._sub = undefined; return }
      if (t === "ping") { send(ws, { type: "pong" }); return }

      if (t === "exec") {
        const sid = typeof msg.sessionID === "string" ? msg.sessionID : ""
        const name = typeof msg.name === "string" ? msg.name : ""
        const command = typeof msg.command === "string" ? msg.command : ""
        if (!sid || !command) return
        const entry = getSessions().find((e) => e.sessionID === sid && e.name === name)
        if (entry) {
          (entry.session as any).exec(command).then(() => {
            const payload = buildSessions()
            const json = JSON.stringify(payload)
            for (const client of wss.clients as Set<WsClient>) {
              if (client.readyState !== WebSocket.OPEN) continue
              client._lastSessionsJson = json
              send(client, { type: "sessions", ...payload })
            }
          })
          const payload = buildSessions()
          const json = JSON.stringify(payload)
          for (const client of wss.clients as Set<WsClient>) {
            if (client.readyState !== WebSocket.OPEN) continue
            client._lastSessionsJson = json
            send(client, { type: "sessions", ...payload })
          }
          return
        }
        const agent = agentBySession.get(sessionKey(sid, name))
        if (agent) {
          const reqId = `${sid}:${name}:${Date.now()}`
          streamBuf.set(sessionKey(sid, name), { data: "", done: false, ts: Date.now() })
          // 新命令开始：重置各订阅者 buf 流游标与 done 状态
          for (const c of wss.clients as Set<WsClient>) {
            if (c.readyState === WebSocket.OPEN && c._sub?.sid === sid && c._sub?.name === name) {
              c._bufPos = 0
              c._sentDone = false
              c._forceSnap = false
              c._snapBase = 0
            }
          }
          send(agent, { type: "run-exec", reqId, sessionID: sid, name, command })
          const payload = buildSessions()
          const json = JSON.stringify(payload)
          for (const client of wss.clients as Set<WsClient>) {
            if (client.readyState !== WebSocket.OPEN) continue
            client._lastSessionsJson = json
            send(client, { type: "sessions", ...payload })
          }
        }
        return
      }

      if (t === "send") {
        const sid = typeof msg.sessionID === "string" ? msg.sessionID : ""
        const name = typeof msg.name === "string" ? msg.name : ""
        const text = typeof msg.text === "string" ? msg.text : ""
        if (!sid || !text) return
        const entry = getSessions().find((e) => e.sessionID === sid && e.name === name)
        if (entry) { (entry.session as any).send(text); return }
        const agent = agentBySession.get(sessionKey(sid, name))
        if (agent) send(agent, { type: "run-send", sessionID: sid, name, text })
        return
      }

      if (t === "deleteTerminal") {
        const sid = typeof msg.sessionID === "string" ? msg.sessionID : ""
        const name = typeof msg.name === "string" ? msg.name : ""
        if (!sid || !name) return
        const entry = getSessions().find((e) => e.sessionID === sid && e.name === name)
        if (entry) { try { entry.session.close() } catch { log.info(`删除终端 ${sid}/${name} 时 close 抛异常`) } }
        else {
          const agent = agentBySession.get(sessionKey(sid, name))
          if (agent) send(agent, { type: "run-delete", sessionID: sid, name })
        }
        removeSessionState(dir, sid, name)
        log.info(`Web 页删除终端 ${sid}/${name}`)
        return
      }
    })

    ws.on("close", () => {
      const reg = agents.get(ws)
      if (reg) {
        for (const k of reg) agentBySession.delete(k)
        agents.delete(ws)
      }
    })
  })

  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo
      actualPort = addr.port
      server.removeListener("error", reject)
      resolve({
        server,
        port: actualPort,
        url: `http://127.0.0.1:${actualPort}`,
        close: () => { clearInterval(streamTimer); clearInterval(statusTimer); server.close(); wss.close() },
      })
    })
  })
}

function renderPage(lang: Lang, template: string): string {
  let out = template
  out = out.replaceAll("{{lang}}", lang)
  for (const key of PAGE_KEYS) {
    out = out.replaceAll(`{{${key}}}`, tr(key, lang))
  }
  const i18nObj: Record<string, string> = {}
  for (const [jsKey, i18nKey] of Object.entries(JS_I18N_KEYS)) {
    i18nObj[jsKey] = tr(i18nKey, lang)
  }
  out = out.replaceAll("__I18N_JSON__", JSON.stringify(i18nObj))
  out = out.replaceAll("__PTY_COLS_VAL__", String(PTY_COLS))
  return out
}

function readTemplate(webDir: string): string {
  const file = join(webDir, "index.html")
  if (!existsSync(file)) {
    return `<!DOCTYPE html><html><body><h1>Web assets not built</h1><p>Run <code>npm run build</code> to build the web frontend.</p></body></html>`
  }
  return readFileSync(file, "utf8")
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
}

function serveStatic(res: import("node:http").ServerResponse, webDir: string, rel: string): void {
  if (rel.includes("\0")) {
    res.writeHead(400)
    res.end("Bad Request")
    return
  }
  const file = normalize(join(webDir, rel))
  if (!file.startsWith(webDir + "\\") && !file.startsWith(webDir + "/") && file !== webDir) {
    res.writeHead(403)
    res.end("Forbidden")
    return
  }
  if (!existsSync(file)) {
    res.writeHead(404)
    res.end("Not Found")
    return
  }
  const ext = extname(file).toLowerCase()
  res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" })
  res.end(readFileSync(file))
}

function readHistoryFromFile(dir: string, sessionID: string, name: string): TranscriptPair[] | null {
  const hdir = join(dir, sessionID, name)
  let files: string[]
  try {
    files = readdirSync(hdir).filter((f) => f.endsWith(".json"))
  } catch {
    return null
  }
  files.sort()
  const out: TranscriptPair[] = []
  for (const f of files) {
    try {
      const data = JSON.parse(readFileSync(join(hdir, f), "utf8")) as { command?: string; output?: string; ts?: number; endTs?: number }
      if (data.command === "__SSH_SEP__") {
        out.push({ type: "sep", ts: data.ts ?? Date.now(), text: "" })
        continue
      }
      if (typeof data.command === "string") out.push({ type: "cmd", ts: data.ts ?? Date.now(), endTs: data.endTs, text: data.command })
      if (typeof data.output === "string") out.push({ type: "out", text: data.output })
    } catch {
      /* skip */
    }
  }
  return out
}