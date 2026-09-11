// 本地 HTTP+WebSocket 服务：HTTP 提供页面/静态资源，WS 承载全部实时数据（会话列表 / transcript 快照 / 运行增量）
// 前端页面为独立 web/ 工程（esbuild 打包到 dist/web/），本文件负责：i18n 占位替换 + 静态资源分发 + WS 协议实现

import { createServer, type Server, type IncomingMessage } from "node:http"
import { readFileSync, readdirSync, existsSync, rmSync } from "node:fs"
import { join, dirname, extname, normalize } from "node:path"
import { fileURLToPath } from "node:url"
import type { AddressInfo } from "node:net"
import { WebSocketServer, WebSocket } from "ws"
import { listAllSessions, removeSessionState } from "./session-store.js"
import { tr, type FlatKey, type Lang } from "./i18n.js"
import { PTY_COLS } from "./constants.js"
import type { SessionHistory } from "./history.js"
import log from "./log.js"

/** 会话实时读写能力（SshSession / LocalSession 均满足，结构接口） */
export interface LiveSession {
  getHistory(): SessionHistory
  getRunningOutput(): string
  getRunningCommand(): string
  hasRunningStream(): boolean
  getRunningStream(): { data: string; done: boolean }
  close(): void
  /** 读取原始字节流增量（从上次 pos 到当前）；reset=true 表示 pos 已被裁，重新发送全量 */
  readRawStream(pos: number): { data: string; pos: number; reset?: boolean }
}

/** 服务实例信息 */
export interface ServerHandle {
  server: Server
  port: number
  url: string
  close(): void
}

/** 扁平会话条目（多终端：sessionID × name 一个条目；kind 区分 ssh/local） */
export interface SessionEntry {
  sessionID: string
  name: string
  session: LiveSession
  kind?: "ssh" | "local"
  title?: string
  directory?: string
}

/** WS 客户端（附加订阅态） */
interface WsClient extends WebSocket {
  _sub?: { sid: string; name: string }
  _lastKey?: string
  _forceSnap?: boolean
  _snapBase?: number
  _wasRunning?: boolean
  _lastSessionsJson?: string
  /** 原始连续流游标（订阅时初始化为当前流末端，之后增量推送） */
  _rawPos?: number
}

/** transcript 消息项：cmd 命令 / out 输出 / run 运行中 / sep 分割线 */
export interface TranscriptPair {
  type: "cmd" | "out" | "run" | "sep"
  ts?: number
  /** 命令完成时刻（cmd 项）；用于展示耗时 */
  endTs?: number
  text: string
}

/** 前端模板中需要替换的 i18n 占位键 */
const PAGE_KEYS: FlatKey[] = [
  "web_title",
  "web_loading",
  "web_time",
  "web_new_messages",
  "web_terminals",
  "web_local",
  "web_delete_terminal",
]

/** 前端 JS 内 I18N 对象键 → i18n key */
const JS_I18N_KEYS: Record<string, FlatKey> = {
  run: "web_running",
  commands: "web_commands",
  autoRefresh: "web_auto_refresh",
  sessionGone: "web_session_gone",
  noSession: "web_no_session",
  loadFailed: "web_load_failed",
  local: "web_local",
  terminals: "web_terminals",
}

/** WS 运行增量轮询间隔 */
const STREAM_TICK_MS = 100
/** runEnd 后等待快照稳定（后台哨兵监听写入 history）的缓冲时间 */
const SNAP_STABLE_MS = 400
/** 会话列表推送间隔（服务端主动推送，非浏览器轮询） */
const STATUS_PUSH_MS = 2000

/**
 * 启动 HTTP + WebSocket 服务（监听 127.0.0.1）
 * @param port 端口，0 或未指定 → 系统随机分配（避免冲突）
 * @param getSessions 获取扁平会话条目列表的函数（供本进程页面展示与实时流）
 * @param dir 插件缓存根目录（跨进程状态文件/历史文件所在处）
 * @param lang Web 界面语言（默认 en）
 * @returns 服务句柄（含实际端口与 URL）
 */
export function startServer(port: number, getSessions: () => SessionEntry[], dir: string, lang: Lang = "en"): Promise<ServerHandle> {
  let actualPort = port
  // 前端产物目录：dist/web（相对本模块 dist/server.js 的上一级）
  const webDir = join(dirname(fileURLToPath(import.meta.url)), "web")
  // 模板只读一次（dist/web/index.html），每次请求做 i18n 占位替换
  const pageTemplate = readTemplate(webDir)

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

    // 静态资源：/web/* → dist/web/*（JS/CSS/字体）
    if (path.startsWith("/web/")) {
      serveStatic(res, webDir, decodeURIComponent(path.slice("/web/".length)))
      return
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
    res.end("Not Found")
  })

  // ===== WebSocket：会话列表 + transcript 快照 + 运行中增量 =====
  const wss = new WebSocketServer({ noServer: true })
  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if (url.pathname !== "/ws") {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req)
    })
  })

  // 发送 JSON 消息给客户端（连接未开则忽略）
  const send = (ws: WsClient, msg: unknown): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  /** 构建聚合会话列表（与旧 /api/status 同构，供 WS sessions 消息推送） */
  const buildSessions = (): Record<string, unknown> => {
    const states = listAllSessions(dir)
    // 用 live 连接修正 stale 状态：进程复苏后旧状态文件里的 connected=true 实为已断开
    const liveKey = new Set(getSessions().map((e) => `${e.sessionID}:${e.name}`))
    for (const s of states) {
      if (s.connected && !liveKey.has(`${s.sessionID}:${s.name}`)) {
        s.connected = false
      }
    }
    const bySession = new Map<string, { title?: string; directory?: string; terminals: { name: string; kind?: string; host?: string; user?: string; port?: number; program?: string; connected: boolean; busy: boolean; pending: number }[] }>()
    for (const s of states) {
      if (!bySession.has(s.sessionID)) bySession.set(s.sessionID, { title: s.title, directory: s.directory, terminals: [] })
      bySession.get(s.sessionID)!.terminals.push({ name: s.name, kind: s.kind, host: s.host, user: s.user, port: s.port, program: s.program, connected: s.connected, busy: s.busy, pending: s.pending })
    }
    const sessions = [...bySession.entries()].map(([sessionID, v]) => ({
      sessionID,
      title: v.title,
      directory: v.directory,
      terminals: v.terminals,
    }))
    return { port: actualPort, sessions }
  }

  /** 构建某终端的 transcript 快照（本进程句柄直读内存；跨进程回退读历史文件） */
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
      // 运行中：命令文本 + 当前输出（前端可立即显示命令行，再跟动画）
      if (entry.session.hasRunningStream()) {
        const runningCmd = entry.session.getRunningCommand()
        if (runningCmd) pairs.push({ type: "cmd", ts: Date.now(), text: runningCmd })
        const running = entry.session.getRunningOutput()
        if (running) pairs.push({ type: "run", text: running })
      }
      return { pairs }
    }
    // 本进程无此会话句柄（跨进程会话/复用服务）→ 从历史文件读取
    const state = listAllSessions(dir).find((s) => s.sessionID === sid && s.name === name)
    const histName = state?.kind === "local" ? `local-${name}` : name
    const pairs = readHistoryFromFile(dir, sid, histName) ?? []
    if (pairs.length === 0 && !state) {
      // 状态文件与历史都消失 = 会话真正删除，前端剔除该幽灵终端
      return { pairs: [], notFound: true }
    }
    return { pairs }
  }

  /** 会话历史指纹（含末对序号+字节数），用于判断是否需要重推快照 */
  const historyKey = (session: LiveSession): string => {
    const hp = session.getHistory().getPairs()
    const last = hp[hp.length - 1]
    return `${hp.length}:${last ? `${last.seq}:${last.size}` : "-"}`
  }

  // WS 定时推送：状态列表（低频）+ 订阅终端的运行增量/快照（高频）
  const streamTimer = setInterval(() => {
    for (const client of wss.clients as Set<WsClient>) {
      if (client.readyState !== WebSocket.OPEN) continue
      const sub = client._sub
      if (!sub) continue
      const entry = getSessions().find((e) => e.sessionID === sub.sid && e.name === sub.name)
      const session = entry?.session
      if (!session) {
        // 跨进程会话（无本进程句柄）：仅在有变化时推文件级快照（低频，退化无实时流）
        const snap = buildSnapshot(sub.sid, sub.name)
        const key = JSON.stringify(snap)
        if (key !== client._lastKey) {
          client._lastKey = key
          send(client, { type: "snapshot", sessionID: sub.sid, name: sub.name, ...snap })
        }
        continue
      }
      // 命令开始运行：检测从空闲→运行切换，立即推送命令文本（前端先渲染命令行，动画紧跟其后）
      const runActive = session.hasRunningStream()
      if (runActive && !client._wasRunning) {
        const cmd = session.getRunningCommand()
        if (cmd) send(client, { type: "cmdStart", command: cmd })
      }
      client._wasRunning = runActive
      // 运行增量推送（cmdStart 之后，保证前端先建命令行再建 run 块）
      const st = session.getRunningStream()
      if (st.done) {
        // 仅首次转 done 时发 runEnd，避免后续 tick 重复发送重置 snapBase
        if (!client._forceSnap) {
          send(client, { type: "runEnd" })
          client._forceSnap = true
          client._snapBase = Date.now()
        }
      } else if (st.data) {
        send(client, { type: "run", data: st.data })
      }
      // 快照推送：runEnd 后等后台写入稳定，或空闲期历史变化（exec 同步完成）
      const key = historyKey(session)
      const forceDone = client._forceSnap && (!runActive || (client._snapBase ?? 0) > 0 && Date.now() - client._snapBase! >= SNAP_STABLE_MS)
      if (forceDone || (!runActive && key !== client._lastKey)) {
        client._forceSnap = false
        client._lastKey = key
        send(client, { type: "snapshot", sessionID: sub.sid, name: sub.name, ...buildSnapshot(sub.sid, sub.name, entry) })
      }
      // Raw 连续流增量推送（订阅时已发全量，此后只推新字节）
      if (client._rawPos !== undefined) {
        const r = session.readRawStream(client._rawPos)
        if (r.data) {
          client._rawPos = r.pos
          send(client, { type: "raw", data: r.data, pos: r.pos, reset: !!r.reset })
        }
      }
    }
  }, STREAM_TICK_MS)

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
      try {
        msg = JSON.parse(raw.toString()) as Record<string, unknown>
      } catch {
        return
      }
      switch (msg.type) {
        case "list": {
          const payload = buildSessions()
          ws._lastSessionsJson = JSON.stringify(payload)
          send(ws, { type: "sessions", ...payload })
          break
        }
        case "subscribe": {
          const sid = typeof msg.sessionID === "string" ? msg.sessionID : ""
          const name = typeof msg.name === "string" ? msg.name : "default"
          if (!sid) return
          ws._sub = { sid, name }
          ws._forceSnap = false
          const entry = getSessions().find((e) => e.sessionID === sid && e.name === name)
          ws._wasRunning = entry?.session.hasRunningStream() ?? false
          // 预置流指针：运行中订阅时先消费一次（丢弃），快照已含当前输出，后续增量不与快照重叠
          entry?.session.getRunningStream()
          const snap = buildSnapshot(sid, name, entry)
          ws._lastKey = entry ? historyKey(entry.session) : JSON.stringify(snap)
          send(ws, { type: "snapshot", sessionID: sid, name, ...snap })
          // Raw 连续流：仅客户端要求且本进程持有会话句柄时启用
          const wantRaw = msg.raw === true
          if (wantRaw && entry) {
            const r = entry.session.readRawStream(0)
            ws._rawPos = r.pos
            send(ws, { type: "raw", data: r.data, pos: r.pos, reset: true })
          } else {
            ws._rawPos = undefined
          }
          break
        }
        case "unsubscribe": {
          ws._sub = undefined
          break
        }
        case "ping": {
          send(ws, { type: "pong" })
          break
        }
        case "deleteTerminal": {
          const sid = typeof msg.sessionID === "string" ? msg.sessionID : ""
          const name = typeof msg.name === "string" ? msg.name : ""
          if (!sid || !name) break
          const entry = getSessions().find((e) => e.sessionID === sid && e.name === name)
          if (entry) {
            // 有活动句柄：close() 已含 history.dispose() 删除历史目录
            entry.session.close()
          } else {
            // 跨进程/陈旧终端：无句柄，直接删除历史目录（历史文件 + 会话记录）
            const histName = `local-${name}`
            const histDir = join(dir, sid, histName)
            const sshDir = join(dir, sid, name)
            try { rmSync(histDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
            try { rmSync(sshDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
          }
          removeSessionState(dir, sid, name)
          log.info(`Web 页删除终端 ${sid}/${name}`)
          break
        }
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
        close: () => {
          clearInterval(streamTimer)
          clearInterval(statusTimer)
          server.close()
          wss.close()
        },
      })
    })
  })
}

/**
 * 渲染终端记录页面：读取编译后的 index.html，替换 i18n 占位符与前端 I18N 对象
 * @param lang 界面语言
 * @param template index.html 模板文本（启动时已读）
 * @returns 最终 HTML 文本
 */
function renderPage(lang: Lang, template: string): string {
  let out = template
  // 语言占位
  out = out.replaceAll("{{lang}}", lang)
  // 文本占位（{{web_xxx}}）
  for (const key of PAGE_KEYS) {
    out = out.replaceAll(`{{${key}}}`, tr(key, lang))
  }
  // 前端 JS I18N 对象（window.__I18N__ = ...）
  const i18nObj: Record<string, string> = {}
  for (const [jsKey, i18nKey] of Object.entries(JS_I18N_KEYS)) {
    i18nObj[jsKey] = tr(i18nKey, lang)
  }
  out = out.replaceAll("__I18N_JSON__", JSON.stringify(i18nObj))
  // PTY 列宽注入（前端 TermScreen 按此列宽渲染，与后端生成 ANSI 的列宽一致，避免错行）
  out = out.replaceAll("__PTY_COLS_VAL__", String(PTY_COLS))
  return out
}

/** 读取前端模板（dist/web/index.html）；缺失时返回引导构建的提示页 */
function readTemplate(webDir: string): string {
  const file = join(webDir, "index.html")
  if (!existsSync(file)) {
    return `<!DOCTYPE html><html><body><h1>Web assets not built</h1><p>Run <code>npm run build</code> to build the web frontend.</p></body></html>`
  }
  return readFileSync(file, "utf8")
}

/** 静态文件类型映射 */
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

/**
 * 分发静态资源（防目录穿越：归一化后校验目标在 webDir 内）
 * @param res 响应对象
 * @param webDir 前端产物根目录
 * @param rel 相对路径（已去 /web/ 前缀）
 */
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

/**
 * 从历史文件读取某终端记录（跨进程场景：本进程无该会话句柄时用）
 * @param dir 插件缓存根目录
 * @param sessionID opencode 会话 ID
 * @param name 终端名（已含 local- 前缀则按本地目录）
 * @returns 结构化消息对（保留 ANSI）；目录不存在返回 null
 */
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
      const data = JSON.parse(readFileSync(join(hdir, f), "utf8")) as { command?: string; output?: string; ts?: number }
      if (data.command === "__SSH_SEP__") {
        out.push({ type: "sep", ts: data.ts ?? Date.now(), text: "" })
        continue
      }
      if (typeof data.command === "string") out.push({ type: "cmd", ts: data.ts ?? Date.now(), endTs: data.endTs, text: data.command })
      if (typeof data.output === "string") out.push({ type: "out", text: data.output })
    } catch {
      /* 跳过损坏文件 */
    }
  }
  return out
}
