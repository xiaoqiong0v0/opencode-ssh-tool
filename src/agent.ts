// 代理客户端：插件进程连上独立服务（WS），注册本进程持有的会话，
// 处理服务转发来的交互命令（run-exec / run-send / run-delete），并把实时流推给服务。

import log from "./log.js"

/** 代理可操作的会话接口（SshSession / LocalSession 子集） */
export interface AgentSession {
  exec(command: string): Promise<unknown>
  send(text: string): { ok: boolean; error?: string }
  close(): void
  hasRunningStream(): boolean
  getRunningStream(): { data: string; done: boolean }
  getRunningCommand(): string
  /** 读取原始字节流增量 */
  readRawStream(pos: number): { data: string; pos: number; reset?: boolean }
}

/** 代理状态 */
export interface AgentHandle {
  close(): void
  /** 重新注册当前会话列表（增删会话后调用） */
  reRegister(): void
}

/**
 * 启动代理客户端：连接独立服务并注册会话，处理转发命令
 * @param url 服务 WS 地址（如 ws://127.0.0.1:PORT/ws）
 * @param resolveSession 按 sessionID/name 取会话句柄
 * @param listSessions 当前本进程持有的全部会话（返回 {sessionID, name}[]）
 * @returns 代理句柄
 */
export function startAgent(
  url: string,
  resolveSession: (sessionID: string, name: string) => AgentSession | undefined,
  listSessions: () => Array<{ sessionID: string; name: string }>,
): AgentHandle {
  let ws: WebSocket | null = null
  let closed = false
  let timer: ReturnType<typeof setInterval> | null = null

  const wsUrl = url.startsWith("ws://") ? url : `ws://${url}`
  const send = (msg: unknown): void => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  const register = (): void => {
    send({ type: "register", sessions: listSessions() })
  }

  const prevRunning = new Set<string>()
  const rawPosMap = new Map<string, number>()

  const pushStreams = (): void => {
    const nowRunning = new Set<string>()
    for (const { sessionID, name } of listSessions()) {
      const session = resolveSession(sessionID, name)
      const key = `${sessionID}:${name}`
      if (!session) continue
      const raw = session.readRawStream(rawPosMap.get(key) ?? 0)
      if (raw.data) {
        rawPosMap.set(key, raw.pos)
        send({ type: "raw", sessionID, name, data: raw.data, pos: raw.pos, reset: !!raw.reset })
      }
      if (!session.hasRunningStream()) continue
      nowRunning.add(key)
      const st = session.getRunningStream()
      if (st.done) {
        send({ type: "stream", sessionID, name, data: st.data, done: true })
        send({ type: "done", sessionID, name })
        nowRunning.delete(key)
      } else if (st.data) {
        const command = !prevRunning.has(key) ? session.getRunningCommand() : undefined
        send({ type: "stream", sessionID, name, data: st.data, command })
      }
    }
    for (const key of prevRunning) {
      if (!nowRunning.has(key)) {
        const sep = key.indexOf(":")
        send({ type: "done", sessionID: key.slice(0, sep), name: key.slice(sep + 1) })
        log.info(`agent pushStreams 转变检测发 done ${key}`)
      }
    }
    prevRunning.clear()
    for (const k of nowRunning) prevRunning.add(k)
  }

  const connect = (): void => {
    if (closed) return
    try {
      ws = new WebSocket(wsUrl)
    } catch (e) {
      log.error("代理连接服务失败", e instanceof Error ? e.message : String(e))
      setTimeout(connect, 2000)
      return
    }
    ws.onopen = () => {
      log.info(`代理已连接 ${wsUrl}`)
      register()
      timer = setInterval(pushStreams, 100)
    }
    ws.onmessage = (ev: MessageEvent) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(String(ev.data)) } catch { return }
      const t = msg.type as string | undefined
      if (!t) return
      if (t === "run-exec") {
        const sid = typeof msg.sessionID === "string" ? msg.sessionID : ""
        const name = typeof msg.name === "string" ? msg.name : ""
        const command = typeof msg.command === "string" ? msg.command : ""
        if (!sid || !command) return
        const session = resolveSession(sid, name)
        if (!session) {
          send({ type: "done", sessionID: sid, name })
          return
        }
        void (async () => {
          try {
            await session.exec(command)
          } catch (e) {
            log.error(`代理执行失败 ${sid}/${name}`, e instanceof Error ? e.message : String(e))
          } finally {
            send({ type: "done", sessionID: sid, name })
          }
        })()
        return
      }
      if (t === "run-send") {
        const sid = typeof msg.sessionID === "string" ? msg.sessionID : ""
        const name = typeof msg.name === "string" ? msg.name : ""
        const text = typeof msg.text === "string" ? msg.text : ""
        const session = resolveSession(sid, name)
        if (session) session.send(text)
        return
      }
      if (t === "run-delete") {
        const sid = typeof msg.sessionID === "string" ? msg.sessionID : ""
        const name = typeof msg.name === "string" ? msg.name : ""
        const session = resolveSession(sid, name)
        if (session) session.close()
        return
      }
    }
    ws.onclose = () => {
      if (timer) { clearInterval(timer); timer = null }
      if (closed) return
      log.info("代理连接断开，2s 后重连")
      setTimeout(connect, 2000)
    }
    ws.onerror = () => { /* onclose 会触发重连 */ }
  }

  connect()

  return {
    close: () => {
      closed = true
      if (timer) { clearInterval(timer); timer = null }
      try { ws?.close() } catch { /* ignore */ }
    },
    reRegister: register,
  }
}
