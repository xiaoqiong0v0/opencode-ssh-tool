// 代理客户端：插件进程连上独立服务（WS），注册本进程持有的会话，
// 处理服务转发来的交互命令（run-exec / run-send / run-delete），并把实时流推给服务。

import log from "./log.js"
import { INTERACTIVE_BUSY_MS } from "./constants.js"

/** 代理可操作的会话接口（SshSession / LocalSession 子集） */
export interface AgentSession {
  exec(command: string): Promise<unknown>
  send(text: string): { ok: boolean; error?: string }
  close(): void
  hasRunningStream(): boolean
  getRunningStream(): { data: string; done: boolean }
  getRunningCommand(): string
  /** 按当前 shell 续行规则拆分多行命令为独立命令 */
  splitCommand(command: string): string[]
  /** 设置命令生命周期监听器（cmdStart/cmdDone 事件源） */
  setLifecycle(listener: ((ev: { type: "start"; command: string; ts: number } | { type: "done"; exitCode: number | null; endTs: number; output?: string }) => void) | null): void
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
  /** 会话执行队列：命令 busy 时 web 提交的命令排队，当前命令完成后依次执行（key=sessionID:name） */
  const execQueue = new Map<string, string[]>()
  /** 各终端最近一次命令提交时间戳（busy 分流：<阈值视为连续命令排队，≥阈值视为交互输入 send） */
  const lastSubmitTs = new Map<string, number>()

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
        // 快速命令（生命周期落在单个 tick 内）可能没被 pushStreams 推过 out：
        // done 携带完整输出时补推一次 out（final=true，server 替换而非追加，
        // 避免与已推的增量重复），保证 web 能看到命令输出（不仅 cmdline）
        if (ev.output) {
          send({ type: "out", sessionID: sid, name, data: ev.output, final: true })
        }
        send({ type: "cmdDone", sessionID: sid, name, exitCode: ev.exitCode, endTs: ev.endTs })
        // 出队下一条命令由 execQueued 在 promise resolve 后处理（见上），此处不再重复出队
      }
    })
  }

  /** 执行单条命令；完成后从队列取下一条继续（在 promise resolve 后才出队，
   *  保证上一条的 running context 已清理，出队的下一条不会因 busy 误判被跳过） */
  const execQueued = (sid: string, name: string, command: string): Promise<void> => {
    const session = resolveSession(sid, name)
    if (!session) {
      send({ type: "cmdDone", sessionID: sid, name, exitCode: null, endTs: Date.now() })
      return Promise.resolve()
    }
    const key = `${sid}:${name}`
    return session.exec(command).then((result) => {
      // exec 同步等待：正常完成/动画等待均会触发生命周期 done（cmdDone）。
      // 仅 quick-fail（busy/未连接，返回 {ok:false}）不会发 done —— 补一条兜底防 server busy 卡死
      if (result && typeof result === "object" && "ok" in result && !(result as { ok: boolean }).ok) {
        // 失败（busy/未连接/引号不闭合等）：把错误文本作为输出回传，web 端可见失败原因
        const err = (result as { error?: string }).error
        if (err) send({ type: "out", sessionID: sid, name, data: err, final: true })
        send({ type: "cmdDone", sessionID: sid, name, exitCode: null, endTs: Date.now() })
      }
      // 出队下一条：此刻上一条已完成，running context 已清理（resolve 在 lifecycle done 之后）
      const q = execQueue.get(key)
      const next = q?.shift()
      if (q && q.length === 0) execQueue.delete(key)
      if (next) { log.info(`agent 队列出队执行 ${sid}/${name}: ${next}`); return execQueued(sid, name, next) }
      return
    }).catch((e) => {
      log.error(`代理执行失败 ${sid}/${name}`, e instanceof Error ? e.message : String(e))
      // 命令未运行（异常）：补充 cmdDone 兜底（正常完成由生命周期上报，server 幂等）
      send({ type: "cmdDone", sessionID: sid, name, exitCode: null, endTs: Date.now() })
      // 异常也应继续出队下一条，避免队列卡死
      const q = execQueue.get(key)
      const next = q?.shift()
      if (q && q.length === 0) execQueue.delete(key)
      if (next) { log.info(`agent 队列异常后出队 ${sid}/${name}: ${next}`); return execQueued(sid, name, next) }
      return
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
        // web 输入框回车 = 提交命令：空闲立即执行；忙时按距上次提交间隔分流——
        //   间隔 < INTERACTIVE_BUSY_MS（连续快速命令，模型连续多行提交）→ 排队依次执行；
        //   间隔 ≥ 阈值仍 busy（用户给运行中的交互程序输入，如 sudo 密码/REPL）→ 原样 send 交程序。
        // 不再用 hasRunningStream() 单点猜测——快速命令窗口内到达的后续命令会被误判为交互输入而裸执行。
        const key = `${sid}:${name}`
        const now = Date.now()
        const last = lastSubmitTs.get(key) ?? 0
        lastSubmitTs.set(key, now)
        if (session.hasRunningStream()) {
          if (now - last < INTERACTIVE_BUSY_MS) {
            const q = execQueue.get(key)
            if (q) q.push(command)
            else execQueue.set(key, [command])
            log.info(`agent run-exec 排队 ${sid}/${name}: ${command} (队列 ${(execQueue.get(key) ?? []).length})`)
            return
          }
          log.info(`agent run-exec busy 超阈值按交互输入 ${sid}/${name}: ${command}`)
          session.send(command + "\r")
          return
        }
        // 多行命令：终端空闲（非交互）时按 shell 续行规则拆成多个独立命令逐条执行（每条独立注入 marker
        // 进 history，避免整段作为一条执行导致多行回显/多行 marker 剥离困难）；busy（交互中）则不拆，
        // 整体交给上面的分流逻辑原样处理。
        const lines = session.splitCommand(command)
        if (!session.hasRunningStream() && lines.length > 1) {
          log.info(`agent run-exec 多行拆分 ${sid}/${name}: ${command.split("\n").length} 行 → ${lines.length} 条`)
          for (const [i, c] of lines.entries()) {
            if (i === 0) void execQueued(sid, name, c)
            else {
              // 循环内每次重新取队列引用：首次用 set 建数组后，后续用 push 追加（避免 set 覆盖丢命令）
              const q = execQueue.get(key)
              if (q) q.push(c)
              else execQueue.set(key, [c])
            }
          }
          return
        }
        log.info(`agent run-exec 直接执行 ${sid}/${name}: ${command}`)
        void execQueued(sid, name, command)
        return
      }
      if (t === "run-send") {
        const sid = typeof msg.sessionID === "string" ? msg.sessionID : ""
        const name = typeof msg.name === "string" ? msg.name : ""
        const text = typeof msg.text === "string" ? msg.text : ""
        const session = resolveSession(sid, name)
        if (session) {
          lastSubmitTs.set(`${sid}:${name}`, Date.now())
          session.send(text)
        }
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
