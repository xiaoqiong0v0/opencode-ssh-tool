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
  /** 设置命令生命周期监听器（cmdStart/cmdDone 事件源） */
  setLifecycle(listener: ((ev: { type: "start"; command: string; ts: number } | { type: "done"; exitCode: number | null; endTs: number }) => void) | null): void
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

  const rawPosMap = new Map<string, number>()
  /** 已挂接生命周期监听的会话对象（按对象去重：同名会话断开重建是新对象，需重新挂接） */
  const lifeHooked = new WeakSet<object>()

  /** 为某个会话挂接生命周期监听：cmdStart/cmdDone 由 BaseSession 精确发出（web exec 与插件 exec 统一来源） */
  const hookLifecycle = (key: string, session: AgentSession): void => {
    if (lifeHooked.has(session)) return
    lifeHooked.add(session)
    const sep = key.indexOf(":")
    const sid = key.slice(0, sep), name = key.slice(sep + 1)
    session.setLifecycle((ev) => {
      if (ev.type === "start") {
        send({ type: "cmdStart", sessionID: sid, name, command: ev.command, ts: ev.ts })
      } else {
        send({ type: "cmdDone", sessionID: sid, name, exitCode: ev.exitCode, endTs: ev.endTs })
      }
    })
  }

  const pushStreams = (): void => {
    for (const { sessionID, name } of listSessions()) {
      const session = resolveSession(sessionID, name)
      const key = `${sessionID}:${name}`
      if (!session) continue
      hookLifecycle(key, session)
      const raw = session.readRawStream(rawPosMap.get(key) ?? 0)
      if (raw.data) {
        rawPosMap.set(key, raw.pos)
        send({ type: "raw", sessionID, name, data: raw.data, pos: raw.pos, reset: !!raw.reset })
      }
      if (!session.hasRunningStream()) continue
      const st = session.getRunningStream()
      if (st.data) send({ type: "out", sessionID, name, data: st.data })
    }
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
          send({ type: "cmdDone", sessionID: sid, name, exitCode: null, endTs: Date.now() })
          return
        }
        // 决策移到 agent 端（web 的 busy/connected 判断有推送延迟）：
        // 终端忙/交互等待（sudo 密码、vi、REPL）→ 原样发送到终端；
        // 空闲 → 作为新命令执行（带 marker 进 history）
        if (session.hasRunningStream()) {
          session.send(command + "\r")
          return
        }
        void (async () => {
          try {
            const result = await session.exec(command)
            // exec 同步等待：正常完成/动画等待均会触发生命周期 done（cmdDone）。
            // 仅 quick-fail（busy/未连接，返回 {ok:false}）不会发 done —— 补一条兜底防 server busy 卡死
            if (result && typeof result === "object" && "ok" in result && !(result as { ok: boolean }).ok) {
              send({ type: "cmdDone", sessionID: sid, name, exitCode: null, endTs: Date.now() })
            }
          } catch (e) {
            log.error(`代理执行失败 ${sid}/${name}`, e instanceof Error ? e.message : String(e))
            // 命令未运行（异常）：补充 cmdDone 兜底（正常完成由生命周期上报，server 幂等）
            send({ type: "cmdDone", sessionID: sid, name, exitCode: null, endTs: Date.now() })
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
