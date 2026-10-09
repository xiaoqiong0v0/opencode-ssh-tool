// 独立 HTTP 服务：聚合多进程会话 + WebSocket 实时流
// 协议（统一事件流）：agent 上报 cmdStart/out/cmdDone/raw，server 按订阅者 _mode 派发 diff/raw；
// snapshot 仅订阅/模式切换时作为基线发送，日常由 diff 增量累积渲染。

import { createServer, type Server, type IncomingMessage } from "node:http"
import { readFileSync, readdirSync, existsSync, rmSync, statSync } from "node:fs"
import { join, dirname, extname, normalize } from "node:path"
import { fileURLToPath } from "node:url"
import type { AddressInfo } from "node:net"
import { WebSocketServer, WebSocket } from "ws"
import { listAllSessions, removeSessionState } from "./session-store.js"
import { tr, type FlatKey, type Lang } from "./i18n.js"
import { PTY_COLS, PTY_ROWS } from "./constants.js"
import log from "./log.js"

export interface LiveSession {
  getHistory(): { getPairs(): unknown[] }
  close(): void
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
  /** 南面模式：transcript=diff 增量 / raw=原始字节流（独立于订阅，切换不重订阅） */
  _mode?: "transcript" | "raw"
  /** 命令输出已推送字节偏移（针对 streamBuf.data；订阅/重建基线对齐末尾，命令开始重置 0） */
  _txPos?: number
  _lastSessionsJson?: string
  _agentId?: string
  _regSessions?: Set<string>
}

export interface TranscriptPair {
  type: "cmd" | "out" | "run" | "sep"
  ts?: number
  endTs?: number
  /** 命令退出码（随 out 对透传；undefined = 未知，前端只显示耗时、不误判成功） */
  exitCode?: number
  text: string
}

/** transcript 通道当前命令缓冲 */
interface StreamBufEntry {
  data: string
  done: boolean
  ts: number
  command: string
  endTs?: number
  exitCode?: number
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
  "web_raw",
]

const JS_I18N_KEYS: Record<string, FlatKey> = {
  commands: "web_commands",
  sessionGone: "web_session_gone",
  noSession: "web_no_session",
  local: "web_local",
  terminals: "web_terminals",
  cmdPlaceholder: "web_cmd_placeholder",
  sendCtrlC: "web_send_ctrlc",
}

const STATUS_PUSH_MS = 2000

const sessionKey = (sid: string, name: string): string => `${sid}:${name}`

export function startServer(
  port: number,
  _getSessions: () => SessionEntry[],
  dir: string,
  lang: Lang = "en",
  _streamTickMs = 100,
): Promise<ServerHandle> {
  let actualPort = port
  const webDir = join(dirname(fileURLToPath(import.meta.url)), "web")
  const pageTemplate = readTemplate(webDir)

  const agents = new Map<WsClient, Set<string>>()
  const agentBySession = new Map<string, WsClient>()
  const streamBuf = new Map<string, StreamBufEntry>()
  const rawBuf = new Map<string, { data: string; pos: number; generation: string }>()
  const cmdCount = new Map<string, number>()
  /** 排队序列保持 busy 的 key（agent 报 more=true 加入，最后一条 done 移除） */
  const seqHold = new Set<string>()

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

  /** 订阅指定会话的 transcript 客户端深拷贝 I/O 深处 */
  const subscribersOf = (sid: string, name: string): WsClient[] => {
    return [...wss.clients as Set<WsClient>].filter(
      (c) => c.readyState === WebSocket.OPEN && c._sub?.sid === sid && c._sub?.name === name,
    )
  }

  const buildSessions = (): Record<string, unknown> => {
    const states = listAllSessions(dir)
    // 补：state 文件可能被清理（重启/断线），但 history 目录仍在——扫描发现离线历史终端
    const histTerms: { sessionID: string; name: string; kind: string }[] = []
    for (const sidDir of readdirSync(dir)) {
      const sidPath = join(dir, sidDir)
      let st: ReturnType<typeof statSync> | null = null
      try { st = statSync(sidPath) } catch { /* 不存在 */ }
      if (!st?.isDirectory()) continue // 跳过 server.json 等根级文件
      let subs: string[]
      try { subs = readdirSync(sidPath) } catch { continue }
      if (!subs.length) continue
      for (const sub of subs) {
        try {
          const subPath = join(sidPath, sub)
          const subSt = statSync(subPath)
          if (subSt.isDirectory() && readdirSync(subPath).some((f) => f.endsWith(".json"))) {
            if (sub.startsWith("local-")) histTerms.push({ sessionID: sidDir, name: sub.slice(6), kind: "local" })
            else histTerms.push({ sessionID: sidDir, name: sub, kind: "ssh" })
          }
        } catch { /* 跳过 */ }
      }
    }
    const seen = new Set<string>()
    const liveKey = new Set(agentBySession.keys())
    const liveBusy = new Map<string, boolean>()
    const now = Date.now()
    // 兜底：streamBuf 中 agent 连接已消失的 key 强制清 busy（agent 崩溃/退出防卡死）。
    // 注意不能用"无 out 超时"判定——交互命令（sudo/read 等输入）等待期间无输出，
    // 但 agent 仍在，命令未完成，busy 必须保持 true（完成由 agent 生命周期钩子兜底，仅断连时 watch 补发 done，无超时强杀）
    for (const [key, b] of streamBuf) {
      if (b && !b.done && !agentBySession.has(key)) {
        b.done = true
        b.ts = now
        b.endTs = now
        finalizeCommand(key)
      }
      if (!agentBySession.has(key)) seqHold.delete(key) // agent 已消失：清排队序列 busy 保持
      liveBusy.set(key, (!!b && !b.done) || seqHold.has(key))
    }
    for (const s of states) {
      if (s.connected && !liveKey.has(sessionKey(s.sessionID, s.name))) {
        s.connected = false
      }
      const lk = sessionKey(s.sessionID, s.name)
      const busy = liveBusy.get(lk)
      if (busy !== undefined) s.busy = busy
      seen.add(sessionKey(s.sessionID, s.name))
    }
    const bySession = new Map<string, { title?: string; directory?: string; terminals: { name: string; kind?: string; host?: string; user?: string; port?: number; program?: string; connected: boolean; busy: boolean; pending: number }[] }>()
    for (const s of states) {
      if (!bySession.has(s.sessionID)) bySession.set(s.sessionID, { title: s.title, directory: s.directory, terminals: [] })
      bySession.get(s.sessionID)!.terminals.push({ name: s.name, kind: s.kind, host: s.host, user: s.user, port: s.port, program: s.program, connected: s.connected, busy: s.busy, pending: s.pending })
    }
    // 补：history 目录里存在但 state 缺失的历史终端（离线展示）
    for (const h of histTerms) {
      const k = sessionKey(h.sessionID, h.name)
      if (seen.has(k)) continue
      seen.add(k)
      if (!bySession.has(h.sessionID)) bySession.set(h.sessionID, { terminals: [] })
      bySession.get(h.sessionID)!.terminals.push({ name: h.name, kind: h.kind, connected: false, busy: false, pending: 0 })
    }
    const sessions = [...bySession.entries()].map(([sessionID, v]) => ({ sessionID, title: v.title, directory: v.directory, terminals: v.terminals }))
    return { port: actualPort, sessions }
  }

  /** 组装全量历史基线（snapshot）：文件历史 + 运行中命令转成 cmd+run 对 */
  const resolveHistName = (sid: string, name: string): string => {
    // 不依赖 state 文件（断线/重启后 state 可能已清理）：直接探测 local 前缀目录
    const base = join(dir, sid)
    // local 终端历史存 `local-${name}`，ssh 存 `${name}`；两者目录名称不能并存取其一
    const localDir = join(base, `local-${name}`)
    const plainDir = join(base, name)
    let hasLocal = false
    let hasPlain = false
    try { hasLocal = readdirSync(localDir).some((f) => f.endsWith(".json")) } catch { /* 目录不存在 */ }
    try { hasPlain = readdirSync(plainDir).some((f) => f.endsWith(".json")) } catch { /* 目录不存在 */ }
    if (hasLocal && !hasPlain) return `local-${name}`
    if (hasPlain && !hasLocal) return name
    // 两者都不存在 → 沿用 state 判定（在线 local 会话刚建历史未落盘时）
    const state = listAllSessions(dir).find((s) => s.sessionID === sid && s.name === name)
    return state?.kind === "local" ? `local-${name}` : name
  }

  const buildSnapshot = (sid: string, name: string): { pairs: TranscriptPair[]; notFound?: boolean } => {
    const state = listAllSessions(dir).find((s) => s.sessionID === sid && s.name === name)
    const histName = resolveHistName(sid, name)
    const pairs = readHistoryFromFile(dir, sid, histName) ?? []
    const sKey = sessionKey(sid, name)
    const buf = streamBuf.get(sKey)
    if (buf && !buf.done && buf.command) {
      pairs.push({ type: "cmd", ts: buf.ts, text: buf.command })
      if (buf.data) pairs.push({ type: "run", text: buf.data })
    }
    if (pairs.length === 0 && !state) return { pairs: [], notFound: true }
    return { pairs }
  }

  /** cmdDone 收尾：cmd 计数 + 广播 diff{done}(transcript) / meta(raw) */
  const finalizeCommand = (sKey: string): void => {
    const [sid, name] = splitKey(sKey)
    const b = streamBuf.get(sKey)
    if (!b || !b.done) return
    cmdCount.set(sKey, (cmdCount.get(sKey) ?? 0) + 1)
    for (const c of subscribersOf(sid, name)) {
      if (c._mode === "raw") {
        send(c, { type: "meta", sessionID: sid, name, commands: cmdCount.get(sKey) })
      } else {
        send(c, { type: "diff", sessionID: sid, name, event: "done", exitCode: b.exitCode, endTs: b.endTs })
      }
    }
  }

  const splitKey = (key: string): [string, string] => {
    const sep = key.indexOf(":")
    return [key.slice(0, sep), key.slice(sep + 1)]
  }

  /** 广播 sessions（json 变化去重；busy 翻转必然变化） */
  const pushSessions = (): void => {
    const payload = buildSessions()
    const json = JSON.stringify(payload)
    for (const client of wss.clients as Set<WsClient>) {
      if (client.readyState !== WebSocket.OPEN) continue
      if (json === client._lastSessionsJson) continue
      client._lastSessionsJson = json
      send(client, { type: "sessions", ...payload })
    }
  }

  const statusTimer = setInterval(() => { pushSessions() }, STATUS_PUSH_MS)

  wss.on("connection", (ws: WsClient) => {
    ws.on("message", (raw) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(raw.toString()) } catch { return }
      const t = msg.type as string | undefined
      if (!t) return

      // ===== agent 上报（唯一数据源） =====

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

      if (t === "cmdStart") {
        const sid = typeof msg.sessionID === "string" ? msg.sessionID : ""
        const name = typeof msg.name === "string" ? msg.name : ""
        const command = typeof msg.command === "string" ? msg.command : ""
        if (!sid || !command) return
        const k = sessionKey(sid, name)
        seqHold.delete(k) // 新命令开始：本条正在运行，busy 由 streamBuf 反映
        const existing = streamBuf.get(k)
        streamBuf.set(k, {
          data: existing && existing.done ? "" : existing?.data ?? "",
          done: false,
          ts: typeof msg.ts === "number" ? msg.ts : Date.now(),
          command,
        })
        for (const c of subscribersOf(sid, name)) {
          if (c._mode === "raw") continue
          // 新命令：重置推送游标，通知命令开始
          c._txPos = 0
          send(c, { type: "diff", sessionID: sid, name, event: "cmd", command, ts: streamBuf.get(k)!.ts })
        }
        pushSessions()
        return
      }

      if (t === "out") {
        const sid = typeof msg.sessionID === "string" ? msg.sessionID : ""
        const name = typeof msg.name === "string" ? msg.name : ""
        const data = typeof msg.data === "string" ? msg.data : ""
        if (!sid || !data) return
        const k = sessionKey(sid, name)
        const isFinal = msg.final === true
        const existing = streamBuf.get(k)
        if (isFinal) {
          // 命令完成时 agent 补推的"处理后完整输出"：替换（而非追加）避免与已推增量重复，
          // 并强制推给所有 transcript 订阅者（重置游标 = 丢弃动画帧累积，用干净结果重建块）
          streamBuf.set(k, { data, done: false, ts: Date.now(), command: existing?.command ?? "" })
          for (const c of subscribersOf(sid, name)) {
            if (c._mode === "raw") continue
            c._txPos = data.length
            send(c, { type: "diff", sessionID: sid, name, event: "out", data, final: true })
          }
        } else if (existing) {
          existing.data = (existing.data || "") + data
          existing.ts = Date.now()
        } else {
          streamBuf.set(k, { data, done: false, ts: Date.now(), command: "" })
        }
        const len = streamBuf.get(k)!.data.length
        for (const c of subscribersOf(sid, name)) {
          if (c._mode === "raw") continue
          const from = c._txPos ?? len
          const newData = streamBuf.get(k)!.data.slice(from)
          if (newData) {
            c._txPos = len
            send(c, { type: "diff", sessionID: sid, name, event: "out", data: newData })
          }
        }
        return
      }

      if (t === "cmdDone") {
        const sid = typeof msg.sessionID === "string" ? msg.sessionID : ""
        const name = typeof msg.name === "string" ? msg.name : ""
        if (!sid) return
        const k = sessionKey(sid, name)
        // 排队序列：agent 报 more=true（队列还有后续命令）→ 保持 busy，直到最后一条 done
        if (msg.more === true) seqHold.add(k)
        else seqHold.delete(k)
        const b = streamBuf.get(k)
        if (b) {
          if (b.done) return // 幂等：同一命令只收尾一次
          b.done = true
          b.endTs = typeof msg.endTs === "number" ? msg.endTs : Date.now()
          // agent 上报退出码可能与六条退出路径不一致（无退出来源 null）
          if (typeof msg.exitCode === "number") b.exitCode = msg.exitCode
        } else {
          streamBuf.set(k, { data: "", done: true, ts: Date.now(), endTs: typeof msg.endTs === "number" ? msg.endTs : Date.now(), command: "" })
        }
        finalizeCommand(k)
        pushSessions()
        return
      }

      if (t === "raw") {
        const sid = typeof msg.sessionID === "string" ? msg.sessionID : ""
        const name = typeof msg.name === "string" ? msg.name : ""
        const data = typeof msg.data === "string" ? msg.data : ""
        const pos = typeof msg.pos === "number" ? msg.pos : 0
        const generation = typeof msg.generation === "string" ? msg.generation : ""
        if (!sid) return
        const k = sessionKey(sid, name)
        const existing = rawBuf.get(k)
        // 代次不同 = 同名会话已重建（或 agent 进程重启）：旧 rawBuf 作废，向订阅者下发 reset 清屏，
        // 再以本帧为新基线（即使 data 为空也要清，不依赖"新数据恰好非空"）。
        // msg.reset=true（agent 重连重发全量/ring 裁剪）同样走 replace 语义，避免叠加重复。
        if (msg.reset === true || !existing || existing.generation !== generation) {
          rawBuf.set(k, { data, pos, generation })
          for (const c of subscribersOf(sid, name)) {
            if (c._mode !== "raw") continue
            send(c, { type: "raw", data, pos, reset: true })
          }
          return
        }
        if (data) {
          rawBuf.set(k, { data: existing.data + data, pos, generation })
          // 直接转发给 raw 订阅者（agent 推的已是增量、WS 保序）
          for (const c of subscribersOf(sid, name)) {
            if (c._mode !== "raw") continue
            send(c, { type: "raw", data, pos, reset: false })
          }
        }
        return
      }

      // ===== web 请求 =====

      if (t === "subscribe") {
        const sid = typeof msg.sessionID === "string" ? msg.sessionID : ""
        const name = typeof msg.name === "string" ? msg.name : ""
        if (!sid) return
        ws._sub = { sid, name }
        const sKey = sessionKey(sid, name)
        const snap = buildSnapshot(sid, name)
        if (snap.notFound) {
          send(ws, { type: "snapshot", sessionID: sid, name, ...snap })
          ws._mode = "transcript"
          return
        }
        const wantRaw = msg.mode === "raw" || msg.raw === true
        if (wantRaw) {
          // raw：不重发 pairs 全量，raw 全量(reset) 已含画面 + 轻量命令计数
          if (!cmdCount.has(sKey)) cmdCount.set(sKey, snap.pairs.filter((p) => p.type === "cmd").length)
          send(ws, { type: "meta", sessionID: sid, name, commands: cmdCount.get(sKey) })
          const r = rawBuf.get(sKey)
          if (r?.data) send(ws, { type: "raw", data: r.data, pos: r.pos, reset: true })
          else {
            // 离线历史会话无实时 rawBuf：用 history 重建原始流供 raw 视图（rawActive 后画面即它）
            const hist = buildRawFromHistory(snap.pairs)
            if (hist) send(ws, { type: "raw", data: hist, pos: hist.length, reset: true })
          }
          ws._mode = "raw"
        } else {
          // transcript：发完整基线，游标对齐缓冲末尾（基线已含全部缓冲内容，后续 out 只推增量）
          send(ws, { type: "snapshot", sessionID: sid, name, ...snap })
          ws._txPos = streamBuf.get(sKey)?.data.length ?? 0
          ws._mode = "transcript"
        }
        return
      }

      if (t === "setMode") {
        if (!ws._sub) return
        const on = msg.mode === "raw"
        const { sid, name } = ws._sub
        const sKey = sessionKey(sid, name)
        if (on) {
          ws._mode = "raw"
          const snap = buildSnapshot(sid, name)
          cmdCount.set(sKey, snap.pairs.filter((p) => p.type === "cmd").length)
          send(ws, { type: "meta", sessionID: sid, name, commands: cmdCount.get(sKey) })
          const r = rawBuf.get(sKey)
          if (r?.data) send(ws, { type: "raw", data: r.data, pos: r.pos, reset: true })
          else {
            // 离线历史会话无实时 rawBuf：用 history 重建原始流供 raw 视图
            const hist = buildRawFromHistory(snap.pairs)
            if (hist) send(ws, { type: "raw", data: hist, pos: hist.length, reset: true })
          }
        } else {
          // raw→transcript：补发完整快照基线，游标对齐（raw 期间未收 diff）
          ws._mode = "transcript"
          const snap = buildSnapshot(sid, name)
          ws._txPos = streamBuf.get(sKey)?.data.length ?? 0
          send(ws, { type: "snapshot", sessionID: sid, name, ...snap })
        }
        return
      }

      if (t === "unsubscribe") { ws._sub = undefined; ws._mode = undefined; return }
      if (t === "ping") { send(ws, { type: "pong" }); return }

      if (t === "exec") {
        const sid = typeof msg.sessionID === "string" ? msg.sessionID : ""
        const name = typeof msg.name === "string" ? msg.name : ""
        const command = typeof msg.command === "string" ? msg.command : ""
        if (!sid || !command) return
        const agent = agentBySession.get(sessionKey(sid, name))
        if (!agent) return
        // 保留运行中流的累积输出：REPL 交互场景下 web 每次回车仍发 exec（非独立命令，无 cmdStart 重置游标），
        // 无条件清空 streamBuf 会让订阅者 _txPos 超出新流长度，后续增量 slice 为空 → transcript 输出丢失。
        // 与 cmdStart 语义一致：仅上一条已完成时清空，进行中（REPL 交互等待）保留累积。
        const k = sessionKey(sid, name)
        const existing = streamBuf.get(k)
        streamBuf.set(k, { data: existing && existing.done ? "" : existing?.data ?? "", done: false, ts: Date.now(), command })
        pushSessions()
        send(agent, { type: "run-exec", reqId: `${sid}:${name}:${Date.now()}`, sessionID: sid, name, command })
        return
      }

      if (t === "send") {
        const sid = typeof msg.sessionID === "string" ? msg.sessionID : ""
        const name = typeof msg.name === "string" ? msg.name : ""
        const text = typeof msg.text === "string" ? msg.text : ""
        if (!sid || !text) return
        const agent = agentBySession.get(sessionKey(sid, name))
        if (agent) send(agent, { type: "run-send", sessionID: sid, name, text })
        return
      }

      if (t === "deleteTerminal") {
        const sid = typeof msg.sessionID === "string" ? msg.sessionID : ""
        const name = typeof msg.name === "string" ? msg.name : ""
        if (!sid || !name) return
        const agent = agentBySession.get(sessionKey(sid, name))
        if (agent) send(agent, { type: "run-delete", sessionID: sid, name })
        removeSessionState(dir, sid, name)
        // 删除该终端的 history 目录：buildSessions 会按 history 目录兜底列出离线历史终端，
        // 只删 state 文件不清目录会导致"删除后页面仍在"（残留被兜底扫描重新发现）
        try {
          const histName = resolveHistName(sid, name)
          rmSync(join(dir, sid, histName), { recursive: true, force: true })
        } catch { /* 目录不存在忽略 */ }
        streamBuf.delete(sessionKey(sid, name))
        rawBuf.delete(sessionKey(sid, name))
        log.info(`Web 页删除终端 ${sid}/${name}`)
        pushSessions()
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
        close: () => { clearInterval(statusTimer); server.close(); wss.close() },
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
  out = out.replaceAll("__PTY_ROWS_VAL__", String(PTY_ROWS))
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
      const data = JSON.parse(readFileSync(join(hdir, f), "utf8")) as { command?: string; output?: string; ts?: number; endTs?: number; exitCode?: number }
      if (data.command === "__SSH_SEP__") {
        out.push({ type: "sep", ts: data.ts ?? Date.now(), text: "" })
        continue
      }
      if (typeof data.command === "string") out.push({ type: "cmd", ts: data.ts ?? Date.now(), endTs: data.endTs, text: data.command })
      // 老记录无 exitCode 字段 → 保持 undefined（未知），前端不显示退出标识
      if (typeof data.output === "string") out.push({ type: "out", exitCode: typeof data.exitCode === "number" ? data.exitCode : undefined, text: data.output })
    } catch {
      /* skip */
    }
  }
  return out
}

/**
 * 从历史消息对重建原始字节流（raw 视图）：拼接所有命令对为 `命令\r\n输出` 流。
 * 离线历史会话无实时 rawBuf 时供 raw 模式显示。
 * 注意：命令文本（`command` 字段）换行是裸 `\n`，须规范成 `\r\n`，否则 xterm 只换行不复位、渲染成阶梯错位；
 * 输出（`output` 字段）是原始字节本就带 `\r\n`，保持保真不改写。
 * @param pairs 历史命令/输出对（snapshot 基线）
 * @returns 重建的原始流
 */
function buildRawFromHistory(pairs: TranscriptPair[]): string {
  let raw = ""
  for (const p of pairs) {
    if (p.type === "cmd") {
      raw += p.text.replace(/\r?\n/g, "\r\n") + "\r\n"
    } else if (p.type === "out" || p.type === "run") {
      raw += p.text
      // 输出末段若未换行则补一个换行，分隔下一条命令
      if (!p.text.endsWith("\n") && !p.text.endsWith("\r")) raw += "\r\n"
    } else if (p.type === "sep") {
      raw += "\r\n"
    }
  }
  return raw
}