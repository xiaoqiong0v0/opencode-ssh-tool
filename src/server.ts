// 独立 HTTP 服务：聚合多进程会话 + WebSocket 实时流
// 协议（统一事件流）：agent 上报 cmdStart/out/cmdDone/raw，server 按订阅者 _mode 派发 diff/raw；
// snapshot 仅订阅/模式切换时作为基线发送，日常由 diff 增量累积渲染。

import { createServer, type Server, type IncomingMessage } from "node:http"
import { readFileSync, readdirSync, existsSync, rmSync, statSync } from "node:fs"
import { join, dirname, extname, normalize } from "node:path"
import { fileURLToPath } from "node:url"
import type { AddressInfo } from "node:net"
import { WebSocketServer, WebSocket } from "ws"
import { listAllSessions, removeSessionState, sweepStaleOrphanStateFiles, type SessionState } from "./session-store.js"
import { tr, type FlatKey, type Lang } from "./i18n.js"
import {
  PTY_COLS,
  PTY_ROWS,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  HEARTBEAT_CLIENT_TIMEOUT_MS,
  STATUS_PUSH_DEBOUNCE_MS,
  STATUS_PUSH_FALLBACK_MS,
  ORPHAN_STATE_GRACE_MS,
  ORPHAN_STATE_MIN_AGE_MS,
  STALE_ORPHAN_MS,
} from "./constants.js"
import log, { infoDedup } from "./log.js"

export interface LiveSession {
  getHistory(): { getPairs(): unknown[] }
  close(): void
}

export interface ServerHandle {
  server: Server
  port: number
  url: string
  close(): void
  /**
   * 订阅"是否有 agent 连接"的**边沿**回调（true=至少一个 agent 已连；false=最后一个 agent 已断开）。
   * 供 server-entry 做事件驱动的空闲关闭：不再周期轮询状态文件，改为在最后一个 agent 断开时起计时。
   * 订阅时会立即回调一次当前状态，避免订阅方错过此前发生的边沿。回调异常不影响服务。
   */
  onAgentPresence(cb: (present: boolean) => void): void
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
  /** 心跳：是否已发 ping 且尚未收到本连接的 pong（true=等待应答中） */
  _awaitPong?: boolean
  /** 等待本条 ping 的 pong 超时定时器（收到 pong 时清除） */
  _pongTimer?: ReturnType<typeof setTimeout>
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
  "web_raw",
]

const JS_I18N_KEYS: Record<string, FlatKey> = {
  commands: "web_commands",
  sessionGone: "web_session_gone",
  noSession: "web_no_session",
  local: "web_local",
  terminals: "web_terminals",
  cmdPlaceholder: "web_cmd_placeholder",
  directInput: "web_direct_input",
  inputOn: "web_input_on",
  inputOff: "web_input_off",
  inputDisconnected: "web_input_disconnected",
  inputOffline: "web_input_offline",
  deleteBlocked: "web_delete_blocked",
  deleteFailed: "web_delete_failed",
}

const sessionKey = (sid: string, name: string): string => `${sid}:${name}`

/**
 * 会话键（`sid:name`）转日志显示形式（`sid/name`）：与终端侧 `[busy]`/`[run]` 行同一写法，
 * 保证所有带会话上下文的日志都能用同一个 `<主会话ID>/<终端名>` 口径 grep。
 * @param sKey 会话键（sid:name）
 * @returns 显示用标签（ses_xxx/default）；无分隔符时原样返回
 */
const keyTag = (sKey: string): string => {
  const i = sKey.indexOf(":")
  return i < 0 ? sKey : `${sKey.slice(0, i)}/${sKey.slice(i + 1)}`
}

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
  /** 服务启动时刻（孤儿状态文件清理的启动宽限基准，见 ORPHAN_STATE_GRACE_MS） */
  const serverStartedAt = Date.now()
  /**
   * 本服务是否绑定在固定端口（port>0）。
   * port=0 表示每个 opencode 实例各自起一个随机端口服务，本服务只能看见连到自己的 agent，
   * "无已连 agent 认领"无法区分孤儿与**别的实例正在使用的活会话**，故磁盘孤儿清理不安全（见 sweepOrphanStateFiles）。
   */
  const isFixedPortServer = port !== 0

  const agents = new Map<WsClient, Set<string>>()
  const agentBySession = new Map<string, WsClient>()

  /** 当前是否存在 agent 连接（边沿状态，供 notifyAgentPresence 去重） */
  let agentPresent = false
  /** "存在 agent 连接"边沿的订阅者（server-entry 用于事件驱动空闲关闭） */
  const presenceListeners: Array<(present: boolean) => void> = []
  /** 在 agents 集合发生"空 ↔ 非空"翻转时通知订阅者（无翻转则不发） */
  const notifyAgentPresence = (): void => {
    const present = agents.size > 0
    if (present === agentPresent) return
    agentPresent = present
    for (const cb of presenceListeners) {
      try { cb(present) } catch { /* 订阅回调异常不影响服务 */ }
    }
  }
  const streamBuf = new Map<string, StreamBufEntry>()
  const rawBuf = new Map<string, { data: string; pos: number; generation: string }>()
  const cmdCount = new Map<string, number>()
  /** 排队序列保持 busy 的 key（agent 报 more=true 加入，最后一条 done 移除） */
  const seqHold = new Set<string>()

  /** server 侧各终端最近一次的对外 busy 状态（仅用于日志：翻转时记一行） */
  const busyState = new Map<string, boolean>()

  /**
   * 各 key 是否已处于"无 agent 连接且命令未完成"的 fallback 状态（仅用于日志：**边沿触发**）。
   * buildSessions 由状态事件驱动（及低频兜底）被调用，故用 per-key 上一轮状态做**幂等**判定：
   * 仅在进入该状态（首转 fallback）与离开该状态（agent 重连 / 命令收尾）各记一行，稳定期间不记。
   */
  const fallbackState = new Set<string>()

  /**
   * 记录 server 侧 busy 翻转（仅在值变化时输出一行，带 session/终端/原因）：
   * 与终端侧 [busy] 行互补，便于对齐"server 认为忙/闲"的时间线。
   * @param sKey 会话键（sid:name）
   * @param next 目标 busy 值
   * @param reason 翻转原因（cmdStart / cmdDone / exec / 无 agent 强制 done / 状态文件回退 等）
   */
  const logBusy = (sKey: string, next: boolean, reason: string): void => {
    if (busyState.get(sKey) === next) return
    busyState.set(sKey, next)
    log.info(`[busy] server ${keyTag(sKey)} busy=${next} reason=${reason}`)
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    const path = url.pathname

    if (path === "/health") {
      // 自证身份：返回本服务进程 pid，供 ensureServer 在终止旧进程前校验归属（防 pid 复用误杀）
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ ok: true, pid: process.pid }))
      return
    }

    if (path === "/") {
      const html = renderPage(lang, pageTemplate)
      // 不缓存：页面内联的 __I18N__ 由本进程注入，若被浏览器缓存会在 server 重启后与磁盘上的 app.js 版本错配
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
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

  /**
   * 收到客户端应用层 pong：清除"等待应答"标记与超时定时器（心跳闭环）。
   * @param ws 收到 pong 的连接
   */
  const markPong = (ws: WsClient): void => {
    ws._awaitPong = false
    if (ws._pongTimer) { clearTimeout(ws._pongTimer); ws._pongTimer = undefined }
  }

  /** 所有已连 agent 认领的会话键并集（多实例：任一实例认领即视为有主） */
  const claimedByAnyAgent = (): Set<string> => {
    const claimed = new Set<string>()
    for (const set of agents.values()) for (const k of set) claimed.add(k)
    return claimed
  }

  /**
   * 清理"无任何已连 agent 认领"的**磁盘状态文件**（一次清完全部陈旧孤儿，收敛性由周期性调用保证）：
   * 正常关闭会调 removeSessionState 删文件，残留即属主进程异常退出（或进程退出兜底未清理）留下的孤儿；
   * 其 connected=true/busy=true 不会自愈——旧实现只在 register 时读，故会长期误报"在线/忙"，
   * 还会让 server-entry 的"无连接空闲自动关闭"永不触发。只删状态文件，**不动 history 目录**（离线历史仍可查看）。
   * 保守优先：
   * - **仅固定端口（port>0）服务执行**：port=0 时每实例各起一个服务（默认 config），本服务的"未认领"无法
   *   区分孤儿与别的实例正在使用的活会话 → 直接跳过，宁可不清理也不删活数据；
   * - 服务启动不足 ORPHAN_STATE_GRACE_MS 时跳过——给存量 agent 重连、注册的窗口，防误删活进程文件；
   * - 仅清理 updatedAt 早于 ORPHAN_STATE_MIN_AGE_MS 的文件——避免误删刚写入、agent 尚未注册的文件。
   * 说明：旧实现仅在 agent register 时触发且要求 agents.size>0，若孤儿在当轮尚未陈旧、或此后再无 agent 注册，
   * 就会永远留下尾巴；现改为由 statusFallbackTimer 周期调用（每次清完全部匹配项并回报剩余数），可持续收敛。
   * @param claimed 所有已连 agent 认领的会话键并集
   */
  const sweepOrphanStateFiles = (claimed: Set<string>): void => {
    if (!isFixedPortServer) return
    if (Date.now() - serverStartedAt < ORPHAN_STATE_GRACE_MS) return
    const { removed, remaining } = sweepStaleOrphanStateFiles(dir, claimed, Date.now(), ORPHAN_STATE_MIN_AGE_MS)
    if (!removed.length && !remaining.length) return
    infoDedup(
      `orphan-state:${removed.length}:${remaining.length}:${removed.map((s) => sessionKey(s.sessionID, s.name)).sort().join(",")}`,
      `清理无 agent 认领的孤儿状态文件 ${removed.length} 个，剩余未陈旧 ${remaining.length} 个` +
        (removed.length ? `（已清: ${removed.map((s) => keyTag(sessionKey(s.sessionID, s.name))).join(", ")}）` : "") +
        (remaining.length ? `（保留: ${remaining.map((s) => keyTag(sessionKey(s.sessionID, s.name))).join(", ")}）` : ""),
    )
  }

  /**
   * 清理"无任何已连 agent 认领"的终端运行态（僵尸条目）：
   * agent 断开后其运行态（streamBuf 的 done=false / rawBuf / 排队保持等）若无人接管会永久滞留，
   * 导致 busy 恒为 ⏳、[fallback] 长期存在、离线终端仍被当成"运行中"。
   * 多实例安全：只回收**所有已连 agent 都没认领**的 key——任一实例注册时都可安全回收孤儿；
   * 仍被本实例或其它实例认领的条目一律不动。history 落盘历史**不删**（仅供离线查看）。
   * 同时（同一注册时机）清理无人认领的**状态文件**（见 sweepOrphanStateFiles），不留孤儿文件。
   */
  const cleanupOrphanRuntime = (): void => {
    const claimed = claimedByAnyAgent()
    const orphans: string[] = []
    for (const k of streamBuf.keys()) if (!claimed.has(k)) orphans.push(k)
    for (const k of rawBuf.keys()) if (!claimed.has(k) && !orphans.includes(k)) orphans.push(k)
    for (const k of seqHold) if (!claimed.has(k) && !orphans.includes(k)) orphans.push(k)
    for (const k of orphans) {
      streamBuf.delete(k)
      rawBuf.delete(k)
      seqHold.delete(k)
      cmdCount.delete(k)
      busyState.delete(k)
      fallbackState.delete(k)
    }
    if (orphans.length) {
      infoDedup(
        `orphan-runtime:${orphans.slice().sort().join(",")}`,
        `清理无 agent 认领的运行态 ${orphans.length} 个: ${orphans.map(keyTag).join(", ")}`,
      )
    }
    sweepOrphanStateFiles(claimed)
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
    // 兜底：streamBuf 中 agent 连接已消失的 key —— **不假报完成**。
    // agent 掉线 ≠ 命令完成：此处不 finalizeCommand、不发 diff done、不改 done 标志，
    // 保持"未完成（busy 不变）"并仅把"agent 离线、命令状态未知"显式落盘（短窗去重防每 2s 刷屏）；
    // agent 重连会补播 cmdStart 恢复状态。注意不能用"无 out 超时"判定——交互命令（sudo/read 等输入）
    // 等待期间无输出，但 agent 仍在、命令未完成，busy 必须保持 true。
    // 命令真实结束只认 agent 上报的当前 seq 完成标记（cmdDone），会话拆除路径另算。
    for (const [key, b] of streamBuf) {
      const inFallback = !!b && !b.done && !agentBySession.has(key)
      if (inFallback && !fallbackState.has(key)) {
        fallbackState.add(key)
        // 边沿触发：仅在首次转入"无 agent 且未完成"时记一行（不含命令内容，防敏感载荷落盘）
        log.info(`[fallback] ${keyTag(key)} 无 agent 连接：命令状态未知（保持未完成，不判完成/不发 diff done）ts=${b.ts}`)
      } else if (!inFallback && fallbackState.has(key)) {
        fallbackState.delete(key)
        // 恢复：agent 重连（重新注册并补播 cmdStart）或命令被收尾，各记一行后回到稳定态不再记
        const reason = agentBySession.has(key) ? "agent 重连" : b?.done ? "命令已收尾" : "状态已恢复"
        log.info(`[fallback] ${keyTag(key)} 恢复：${reason}（退出"无 agent 且未完成"状态）`)
      }
      if (!agentBySession.has(key)) seqHold.delete(key) // agent 已消失：清排队序列 busy 保持
      liveBusy.set(key, (!!b && !b.done) || seqHold.has(key))
    }
    // 清理已从 streamBuf 移除的 key（删除终端 / 缓冲回收）的 fallback 状态，避免同名 key 复用时漏记首次
    for (const k of fallbackState) if (!streamBuf.has(k)) fallbackState.delete(k)
    for (const s of states) {
      const lk = sessionKey(s.sessionID, s.name)
      const online = liveKey.has(lk)
      if (s.connected && !online) {
        s.connected = false
      }
      const busy = liveBusy.get(lk)
      if (busy !== undefined) s.busy = busy
      // 无 agent 连接 = 终端离线：busy 归零，不回退状态文件（进程异常退出时那里可能残留 busy=true，
      // 会让离线终端一直显示 ⏳）。离线用既有 ○ 表达，不再叠加"忙"。
      else if (!online) { s.busy = false; logBusy(lk, false, "无 agent 连接(离线)") }
      // 盲点显式化：agent 在线但拿不到实时流状态时，busy 回退取状态文件（可能是命令执行前写的旧值，未必可靠）
      else logBusy(lk, !!s.busy, "状态文件回退(无 agent 状态)")
      seen.add(lk)
    }
    const bySession = new Map<string, { title?: string; directory?: string; terminals: { name: string; kind?: string; host?: string; user?: string; port?: number; program?: string; connected: boolean; busy: boolean; pending: number; canDelete: boolean; deleteReason?: string }[] }>()
    for (const s of states) {
      if (!bySession.has(s.sessionID)) bySession.set(s.sessionID, { title: s.title, directory: s.directory, terminals: [] })
      const elig = deleteEligibility(s.sessionID, s.name, s)
      bySession.get(s.sessionID)!.terminals.push({ name: s.name, kind: s.kind, host: s.host, user: s.user, port: s.port, program: s.program, connected: s.connected, busy: s.busy, pending: s.pending, canDelete: elig.canDelete, deleteReason: elig.reasonKey ? tr(elig.reasonKey, lang) : undefined })
    }
    // 补：history 目录里存在但 state 缺失的历史终端（离线展示）
    for (const h of histTerms) {
      const k = sessionKey(h.sessionID, h.name)
      if (seen.has(k)) continue
      seen.add(k)
      if (!bySession.has(h.sessionID)) bySession.set(h.sessionID, { terminals: [] })
      const elig = deleteEligibility(h.sessionID, h.name)
      bySession.get(h.sessionID)!.terminals.push({ name: h.name, kind: h.kind, connected: false, busy: false, pending: 0, canDelete: elig.canDelete, deleteReason: elig.reasonKey ? tr(elig.reasonKey, lang) : undefined })
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

  /**
   * 取某终端 history 目录的 mtime（毫秒；不存在返回 0）。
   * 状态文件可能已被清理、仅剩历史目录，此时用目录写入时间作为"最近活动"的兜底判据。
   * @param sid 主会话 ID
   * @param name 终端名
   * @returns 目录 mtime；不存在为 0
   */
  const historyDirMtimeMs = (sid: string, name: string): number => {
    let latest = 0
    for (const sub of [name, `local-${name}`]) {
      try { latest = Math.max(latest, statSync(join(dir, sid, sub)).mtimeMs) } catch { /* 目录不存在 */ }
    }
    return latest
  }

  /**
   * Web 删除前的"可删"判据（删除入口与终端列表按钮状态共用）：
   * - 本实例的 agent 认领该终端（agentBySession 有此 key）→ 可删（保持既有行为）；
   * - 否则需三者同时成立才可删：① 离线（本服务无该终端的 agent 连接）② 无任何已连 agent 认领
   *   ③ 已陈旧（最近活动早于 STALE_ORPHAN_MS）。①②在本服务视图下由"非本实例认领"自动成立，
   *   真正的门槛是③——它把"他实例正在使用的活终端"（活动频繁、状态文件新）与"真孤儿"区分开；
   * - "最近活动"取状态文件 updatedAt 与 history 目录 mtime 的较大者，覆盖仅剩历史目录的离线终端。
   * @param sid 主会话 ID
   * @param name 终端名
   * @param state 该终端的状态文件（来自 listAllSessions；缺失时仅用 history 目录判陈旧）
   * @returns canDelete=是否可删；reasonKey=不可删时的 i18n 文案键
   */
  const deleteEligibility = (sid: string, name: string, state?: SessionState): { canDelete: boolean; reasonKey?: FlatKey } => {
    const k = sessionKey(sid, name)
    if (agentBySession.has(k)) return { canDelete: true }
    // ① 离线：本服务无该终端的 agent 连接；② 无认领：不属于任一已连 agent 的认领集合。
    // 本模块不变量下二者等价（agentBySession 与 agents 的认领集合同步维护），显式判断以表达判据、防未来解耦。
    const offline = !agentBySession.has(k)
    const unclaimed = !claimedByAnyAgent().has(k)
    if (!offline || !unclaimed) return { canDelete: false, reasonKey: "web_delete_refused_active" }
    const lastActive = Math.max(state?.updatedAt ?? 0, historyDirMtimeMs(sid, name))
    if (Date.now() - lastActive <= STALE_ORPHAN_MS) return { canDelete: false, reasonKey: "web_delete_refused_recent" }
    return { canDelete: true }
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

  /**
   * 注册时的运行态对账（修复"断线丢 cmdDone → server 内存僵尸 busy"）：
   * agent 注册时上报"本进程认领的全部终端"（register.sessions）与"其中真正在运行命令的子集"（register.running）。
   * 对**本 agent 认领、但不在运行子集内**的终端，把 server 仍标记 done=false 的残留流收尾
   * （置 done、广播 diff done、busy 归 false）——这正是"命令在 agent 断线期间完成、cmdDone 发往已死 socket 而丢失"的僵尸。
   * 只在对账可确定时收尾：register 未携带 running（旧 agent / agent 自身无法确定）时**不臆测**，
   * 仅记一行"未能对账"后保持现状（宁可保留僵尸，也不误判在线命令已完成）。
   * @param claimKeys 本 agent 本次认领的会话键集合
   * @param runningRaw register 消息里的 running 字段（未知类型，需运行时校验）
   */
  const reconcileAgentRuntime = (claimKeys: Set<string>, runningRaw: unknown): void => {
    if (!Array.isArray(runningRaw)) {
      log.info(`[reconcile] agent 注册未携带运行集合（未能对账），保持现状不臆测（认领 ${claimKeys.size} 个终端）`)
      return
    }
    const running = new Set<string>()
    for (const r of runningRaw as Array<{ sessionID?: unknown; name?: unknown }>) {
      if (r && typeof r.sessionID === "string" && typeof r.name === "string") running.add(sessionKey(r.sessionID, r.name))
    }
    let finalized = 0
    for (const k of claimKeys) {
      if (running.has(k)) continue // 确在运行：保留 busy（agent 紧随其后的 cmdStart 会补播命令文本）
      const b = streamBuf.get(k)
      if (b && !b.done) {
        b.done = true
        b.endTs = b.endTs ?? Date.now()
        logBusy(k, false, "register 对账(cmdDone 丢失)")
        finalizeCommand(k)
        finalized++
        continue
      }
      if (seqHold.has(k)) {
        // 排队保持也一并放开：其最后一条 cmdDone 同样可能随断线丢失，否则 busy 仍会被 hold 住
        seqHold.delete(k)
        logBusy(k, false, "register 对账(队列保持释放)")
        finalized++
      }
    }
    if (finalized) log.info(`[reconcile] agent 注册对账收尾 ${finalized} 个终端（认领但未运行，cmdDone 丢失）`)
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

  /** 状态推送合并定时器（事件驱动的去抖合并；null=空闲无待推） */
  let statusPushTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * 请求一次状态推送（去抖合并）：所有**状态变化事件**（cmdStart/cmdDone/exec/busy 翻转/连接变化/会话增删/客户端拉取）
   * 调用它，窗口内多次只推一次全量最新状态。不变化时不推（pushSessions 内按 json 逐客户端去重）。
   */
  const requestStatusPush = (): void => {
    if (statusPushTimer !== null) return
    statusPushTimer = setTimeout(() => {
      statusPushTimer = null
      pushSessions()
    }, STATUS_PUSH_DEBOUNCE_MS)
  }

  // 兜底：事件驱动已覆盖服务端内存态的全部变化；此低频周期只兜底**带外变化**（其他进程写入状态文件
  // 导致的新终端 / pending / 标题变化等，服务端无对应事件），保证这类变化最长 STATUS_PUSH_FALLBACK_MS 内可达前端。
  // 同时周期重跑孤儿状态文件清理：单轮只清"当下已陈旧"的项，未陈旧者留待下一轮，从而**持续收敛**、
  // 不再依赖 agent register 触发（旧实现只在注册时清，之后再无注册就会永远留下尾巴）。
  const statusFallbackTimer = setInterval(() => {
    sweepOrphanStateFiles(claimedByAnyAgent())
    pushSessions()
  }, STATUS_PUSH_FALLBACK_MS)

  /**
   * 应用层心跳（server 侧）：每隔 HEARTBEAT_INTERVAL_MS 向每条连接下发 {type:"ping"}，
   * 并在 HEARTBEAT_TIMEOUT_MS 内未收到 pong 时 terminate。server↔agent、server↔browser 两条 WS 共用：
   * terminate 后对端 close 事件触发既有自动重连，把"半开连接"变成可发现、可自愈。
   * 心跳只在 WS 通道收发，不写 PTY/终端。
   */
  const heartbeatTimer = setInterval(() => {
    for (const ws of wss.clients as Set<WsClient>) {
      if (ws.readyState !== WebSocket.OPEN) continue
      if (ws._awaitPong) {
        // 上一条 ping 既没等到 pong、超时定时器也未生效（兜底路径）：判定半开，直接断开
        log.info(`[heartbeat] 心跳无应答（兜底）断开连接 agent=${!!agents.get(ws)}`)
        try { ws.terminate() } catch { /* 已关闭 */ }
        continue
      }
      ws._awaitPong = true
      send(ws, { type: "ping" })
      ws._pongTimer = setTimeout(() => {
        if (!ws._awaitPong) return
        log.info(`[heartbeat] 心跳超时 ${HEARTBEAT_TIMEOUT_MS}ms 无 pong，断开连接 agent=${!!agents.get(ws)}`)
        try { ws.terminate() } catch { /* 已关闭 */ }
      }, HEARTBEAT_TIMEOUT_MS)
      if (typeof ws._pongTimer.unref === "function") ws._pongTimer.unref()
    }
  }, HEARTBEAT_INTERVAL_MS)

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
        const claimKeys = new Set<string>()
        for (const s of sessions) {
          const k = sessionKey(s.sessionID, s.name)
          agents.get(ws)!.add(k)
          agentBySession.set(k, ws)
          claimKeys.add(k)
        }
        notifyAgentPresence()
        {
          // 记录 agent 上报的会话列表（批量实例注册同一列表时按内容去重），便于对齐 server 侧视角
          const keys = [...(agents.get(ws) ?? [])]
          infoDedup(
            `agent-register:${keys.slice().sort().join(",")}`,
            `agent 注册 ${keys.length} 个会话: ${keys.length ? keys.map(keyTag).join(", ") : "无"}`,
          )
        }
        // 运行态对账：先按本 agent 上报的"运行子集"收尾断线丢 cmdDone 的僵尸 busy，再回收无人认领的运行态与状态文件
        reconcileAgentRuntime(claimKeys, msg.running)
        cleanupOrphanRuntime()
        requestStatusPush()
        return
      }

      if (t === "cmdStart") {
        const sid = typeof msg.sessionID === "string" ? msg.sessionID : ""
        const name = typeof msg.name === "string" ? msg.name : ""
        const command = typeof msg.command === "string" ? msg.command : ""
        if (!sid || !command) return
        const k = sessionKey(sid, name)
        seqHold.delete(k) // 新命令开始：本条正在运行，busy 由 streamBuf 反映
        logBusy(k, true, "cmdStart")
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
        requestStatusPush()
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
        logBusy(k, msg.more === true, msg.more === true ? "cmdDone(more 保持 busy)" : "cmdDone")
        finalizeCommand(k)
        requestStatusPush()
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

      if (t === "list") {
        // web 连接/重连后主动拉取一次会话列表（原依赖 2s 轮询被动收；改事件驱动后必须显式响应，
        // 否则新开标签页要等兜底周期才有内容）。只回本连接，并按 json 去重。
        const payload = buildSessions()
        const json = JSON.stringify(payload)
        if (json !== ws._lastSessionsJson) {
          ws._lastSessionsJson = json
          send(ws, { type: "sessions", ...payload })
        }
        return
      }

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
      // 应用层心跳应答：客户端收到 server 的 {type:"ping"} 后回 {type:"pong"}，闭环即可
      if (t === "pong") { markPong(ws); return }

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
        logBusy(k, true, "exec")
        requestStatusPush()
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
        const k = sessionKey(sid, name)
        const agent = agentBySession.get(k)
        // "可删"判据（见 deleteEligibility）：本实例 agent 认领 → 可删；否则须"离线 + 无认领 + 陈旧"。
        // 放宽后仍绝不误删他实例正在用的活终端（其状态文件新近被写、判为未陈旧而拒绝），
        // 同时让 agent 已断开留下的离线孤儿（及仅剩 history 的历史终端）能被网页手动清掉。
        const state = listAllSessions(dir).find((s) => s.sessionID === sid && s.name === name)
        const elig = deleteEligibility(sid, name, state)
        if (!elig.canDelete) {
          const reason = tr(elig.reasonKey ?? "web_delete_blocked", lang)
          log.info(`Web 页删除终端 ${sid}/${name} 被拒：${reason}`)
          // 结构化、可读的拒绝原因回给发起连接（前端据此给可见反馈，不静默）
          send(ws, { type: "deleteResult", sessionID: sid, name, ok: false, reason })
          return
        }
        if (agent) send(agent, { type: "run-delete", sessionID: sid, name })
        removeSessionState(dir, sid, name)
        // 删除该终端的 history 目录：buildSessions 会按 history 目录兜底列出离线历史终端，
        // 只删 state 文件不清目录会导致"删除后页面仍在"（残留被兜底扫描重新发现）
        try {
          const histName = resolveHistName(sid, name)
          rmSync(join(dir, sid, histName), { recursive: true, force: true })
        } catch { /* 目录不存在忽略 */ }
        streamBuf.delete(k)
        rawBuf.delete(k)
        busyState.delete(k)
        log.info(`Web 页删除终端 ${sid}/${name}`)
        send(ws, { type: "deleteResult", sessionID: sid, name, ok: true })
        requestStatusPush()
        return
      }
    })

    ws.on("close", () => {
      if (ws._pongTimer) { clearTimeout(ws._pongTimer); ws._pongTimer = undefined }
      const reg = agents.get(ws)
      if (reg) {
        // 盲点显式化：agent 断开时记录受影响的终端列表（仅 agent 连接，web 订阅者不在此列）
        const keys = [...reg]
        for (const k of reg) agentBySession.delete(k)
        agents.delete(ws)
        infoDedup(`agent-disconnect:${keys.slice().sort().join(",")}`, `agent 断开（受影响终端: ${keys.length ? keys.map(keyTag).join(", ") : "无"}）`)
        // 连接变化是状态事件：立即推一次（原靠 2s 轮询，最坏 2s 才反映离线；改事件驱动后即时）；
        // 同时通知"agent 存在性"边沿（server-entry 据最后一个 agent 断开启动空闲计时）
        notifyAgentPresence()
        requestStatusPush()
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
          if (statusPushTimer) { clearTimeout(statusPushTimer); statusPushTimer = null }
          clearInterval(statusFallbackTimer)
          clearInterval(heartbeatTimer)
          server.close()
          wss.close()
        },
        onAgentPresence: (cb) => {
          presenceListeners.push(cb)
          // 立即回报一次当前状态：订阅方（server-entry）据此决定是否已空闲（无 agent）
          try { cb(agents.size > 0) } catch { /* 订阅回调异常不影响服务 */ }
        },
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
  out = out.replaceAll("__HEARTBEAT_INTERVAL_MS_VAL__", String(HEARTBEAT_INTERVAL_MS))
  out = out.replaceAll("__HEARTBEAT_CLIENT_TIMEOUT_MS_VAL__", String(HEARTBEAT_CLIENT_TIMEOUT_MS))
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
  // 不缓存：静态资源（app.js/app.css）无哈希文件名，缓存会与页面注入的 __I18N__ 版本错配
  res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream", "Cache-Control": "no-store" })
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