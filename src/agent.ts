// 代理客户端：插件进程连上独立服务（WS），注册本进程持有的会话，
// 处理服务转发来的交互命令（run-exec / run-send / run-delete），并把实时流推给服务。

import log, { debug, describeSend, infoDedup, infoDedupShared, tailLines } from "./log.js"
import { INTERACTIVE_BUSY_MS, HEARTBEAT_INTERVAL_MS, HEARTBEAT_CLIENT_TIMEOUT_MS, AGENT_PUSH_MIN_INTERVAL_MS } from "./constants.js"
import { precheckBeforeExec } from "./precheck.js"
import type { TransferTask } from "./transfer-events.js"

/** 代理可操作的会话接口（SshSession / LocalSession 子集） */
export interface AgentSession {
  exec(command: string): Promise<unknown>
  send(text: string): { ok: boolean; error?: string }
  close(): void
  hasRunningStream(): boolean
  getRunningStream(): { data: string; done: boolean }
  getRunningCommand(): string
  /** 设置命令生命周期监听器（cmdStart/cmdDone 事件源） */
  setLifecycle(listener: ((ev: { type: "start"; command: string; ts: number } | { type: "done"; exitCode: number | null; endTs: number; output?: string }) => void) | null): void
  /** 设置数据到达监听器（终端有新输出时回调，供事件驱动推流；null 清除） */
  setDataListener(listener: (() => void) | null): void
  /** 读取原始字节流增量 */
  readRawStream(pos: number): { data: string; pos: number; reset?: boolean }
  /** 会话实例代次：同名重建/进程重启后变化，用于判定新会话并重置 raw 增量游标 */
  readonly generation: string
  /** 探测到的 shell 适配器名（供发送前语法预检选择校验器） */
  readonly shellName: string | null
  /** 是否本地会话（SSH 远程不接预检） */
  readonly isLocal: boolean
}

/** 代理状态 */
export interface AgentHandle {
  close(): void
  /** 重新注册当前会话列表（增删会话后调用） */
  reRegister(): void
  /**
   * 上报一条传输任务（只发元数据，不含文件内容）。
   * WS 未连接时静默丢弃：任务可见性依赖连接恢复，不影响传输本身。
   * @param task 传输任务元数据
   */
  transfer(task: TransferTask): void
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
  /** 推流合并定时器（数据事件驱动：一次只挂一个 setTimeout，把窗口内多次到达合并成一帧） */
  let pushTimer: ReturnType<typeof setTimeout> | null = null
  /** 最近一次实际推流时刻（毫秒），用于计算下一次最早可推时刻（节流合流） */
  let lastPushAt = 0
  /** 心跳检测定时器（与推流合并定时器分开，断开时一并清理） */
  let hbTimer: ReturnType<typeof setInterval> | null = null
  /** 最近一次收到 server 应用层 ping 的时刻（毫秒）；静默超过 HEARTBEAT_CLIENT_TIMEOUT_MS 即判定服务端半开 */
  let lastPingAt = 0
  /** 连接成功次数（1=首次连接，>1=重连），用于在日志里区分首连与重连 */
  let connSeq = 0

  const wsUrl = url.startsWith("ws://") ? url : `ws://${url}`
  const send = (msg: unknown): void => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  /**
   * 收集"当前正在运行命令"的终端集合（供 server 注册时对账）。
   * 与 register.sessions（本进程认领的全部终端）配套：server 把"被认领但不在运行集合内"的
   * 残留 busy 收尾，修复断线期间 cmdDone 丢失导致的僵尸 busy（server 内存 done=false 永不收尾）。
   * 无法确定即返回 undefined（不臆测）：某认领终端取不到句柄、或枚举抛异常时整体降级；
   * server 收到非数组会只记一行"未能对账"并保持现状（宁可保留，也不误判在线命令已完成）。
   * @returns 运行中终端列表；无法确定时 undefined
   */
  const collectRunning = (): Array<{ sessionID: string; name: string }> | undefined => {
    try {
      const out: Array<{ sessionID: string; name: string }> = []
      for (const { sessionID, name } of listSessions()) {
        const s = resolveSession(sessionID, name)
        if (!s) return undefined // 有认领却取不到句柄：该终端状态无法确定
        if (s.hasRunningStream()) out.push({ sessionID, name })
      }
      return out
    } catch {
      return undefined
    }
  }

  const register = (): void => {
    // 同批上报认领的会话列表 + 其中真正运行命令的子集，供 server 注册时做运行态对账
    send({ type: "register", sessions: listSessions(), running: collectRunning() })
    // 注册后调度一次推流：挂接新增/重建会话的监听，并推送初始 raw（代次变化时带 reset）。
    // 会话增删经 index.refreshAgent→reRegister 到这里，不依赖任何周期轮询。
    schedulePush()
  }

  /** raw 增量游标：按会话实例代次记录已推位置；代次不同即新会话，从 0 重新读 */
  const rawPosMap = new Map<string, { gen: string; pos: number }>()
  /** 已挂接生命周期监听的会话对象（按对象去重：同名会话断开重建是新对象，需重新挂接） */
  const lifeHooked = new WeakSet<object>()
  /** 已挂接数据到达监听的会话对象（按对象去重，同上：重建后的新对象需重新挂接） */
  const dataHooked = new WeakSet<object>()
  /** 会话执行队列：命令 busy 时 web 提交的命令排队，当前命令完成后依次执行（key=sessionID:name） */
  const execQueue = new Map<string, string[]>()
  /** 各终端最近一次命令提交时间戳（busy 分流：<阈值视为连续命令排队，≥阈值视为交互输入 send） */
  const lastSubmitTs = new Map<string, number>()

  /**
   * 事件驱动的推流调度（节流合并）：由数据到达事件、注册/重连触发，取代原固定 100ms 轮询。
   * - 空闲（无数据、无注册）时不挂任何定时器 → 零周期回调；
   * - 到达时：距上次推流已满最小间隔则尽快推（wait=0，前沿），否则挂一个 setTimeout 等到满间隔再推，
   *   窗口内多次到达只挂一个定时器、合并为一帧（尾沿），避免逐 chunk 打爆 WS；
   * - 回调始终读取各会话最新游标，窗口内到达的数据必然被这一帧带走，绝不漏推。
   */
  const schedulePush = (): void => {
    if (pushTimer !== null) return
    const wait = Math.max(0, AGENT_PUSH_MIN_INTERVAL_MS - (Date.now() - lastPushAt))
    pushTimer = setTimeout(() => {
      pushTimer = null
      lastPushAt = Date.now()
      pushStreams()
    }, wait)
  }

  /** 为一个会话挂接监听：数据到达（驱动推流调度）+ 生命周期（cmdStart/cmdDone，BaseSession 精确发出） */
  const hookSession = (key: string, session: AgentSession): void => {
    if (!dataHooked.has(session)) {
      dataHooked.add(session)
      // 会话每有新输出即调度一次合并推流：ssh2 的 stream.on("data") 与本地 PTY 的 data 回调
      // 最终都汇入 BaseSession._appendBuffer，在那统一触发本监听
      session.setDataListener(() => schedulePush())
    }
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
        // 排队序列：队列里还有后续命令 → more=true，server 据此保持 busy=true（中间不闪 false）
        const more = (execQueue.get(key)?.length ?? 0) > 0
        send({ type: "cmdDone", sessionID: sid, name, exitCode: ev.exitCode, endTs: ev.endTs, more })
        // 出队下一条命令由 execQueued 在 promise resolve 后处理（见上），此处不再重复出队
      }
    })
  }

  /** 执行单条命令；完成后从队列取下一条继续（在 promise resolve 后才出队，
   *  保证上一条的 running context 已清理，出队的下一条不会因 busy 误判被跳过） */
  const execQueued = async (sid: string, name: string, command: string): Promise<void> => {
    const session = resolveSession(sid, name)
    if (!session) {
      send({ type: "cmdDone", sessionID: sid, name, exitCode: null, endTs: Date.now() })
      return
    }
    const key = `${sid}:${name}`
    /** 队列是否还有后续命令（排队命令）→ 决定 server 是否保持 busy */
    const hasMore = (): boolean => (execQueue.get(key)?.length ?? 0) > 0
    // web run-exec 与 term_exec 共用发送前语法预检：命中即拦，不写终端、不发 cmdStart
    const rejection = await precheckBeforeExec(session, command)
    if (rejection) {
      log.tool("web_run_precheck_rejected", { sessionID: sid, name, command: tailLines(command, 3), shell: session.shellName })
      send({ type: "out", sessionID: sid, name, data: rejection, final: true })
      send({ type: "cmdDone", sessionID: sid, name, exitCode: null, endTs: Date.now(), more: hasMore() })
      const q = execQueue.get(key)
      const next = q?.shift()
      if (q && q.length === 0) execQueue.delete(key)
      if (next) return execQueued(sid, name, next)
      return
    }
    return session.exec(command).then((result) => {
      // exec 同步等待：正常完成/动画等待均会触发生命周期 done（cmdDone）。
      // 仅 quick-fail（busy/未连接，返回 {ok:false}）不会发 done —— 补一条兜底防 server busy 卡死
      if (result && typeof result === "object" && "ok" in result && !(result as { ok: boolean }).ok) {
        // 失败（busy/未连接/引号不闭合等）：把错误文本作为输出回传，web 端可见失败原因
        const err = (result as { error?: string }).error
        if (err) send({ type: "out", sessionID: sid, name, data: err, final: true })
        send({ type: "cmdDone", sessionID: sid, name, exitCode: null, endTs: Date.now(), more: hasMore() })
      }
      // 出队下一条：此刻上一条已完成，running context 已清理（resolve 在 lifecycle done 之后）
      const q = execQueue.get(key)
      const next = q?.shift()
      if (q && q.length === 0) execQueue.delete(key)
      if (next) { log.info(`agent 队列出队执行 ${sid}/${name} cmdLen=${next.length}`); debug(`agent 队列出队命令 ${sid}/${name} cmd=${tailLines(next, 3)}`); return execQueued(sid, name, next) }
      // 队列已空：序列结束（各命令的 busy 由自身 cmdDone 生命周期收尾，无需额外状态处理）
      return
    }).catch((e) => {
      log.error(`代理执行失败 ${sid}/${name}`, e instanceof Error ? e.message : String(e))
      // 命令未运行（异常）：补充 cmdDone 兜底（正常完成由生命周期上报，server 幂等）
      send({ type: "cmdDone", sessionID: sid, name, exitCode: null, endTs: Date.now(), more: hasMore() })
      // 异常也应继续出队下一条，避免队列卡死
      const q = execQueue.get(key)
      const next = q?.shift()
      if (q && q.length === 0) execQueue.delete(key)
      if (next) { log.info(`agent 队列异常后出队 ${sid}/${name} cmdLen=${next.length}`); debug(`agent 队列异常后出队命令 ${sid}/${name} cmd=${tailLines(next, 3)}`); return execQueued(sid, name, next) }
      return
    })
  }

  const pushStreams = (): void => {
    for (const { sessionID, name } of listSessions()) {
      const session = resolveSession(sessionID, name)
      const key = `${sessionID}:${name}`
      if (!session) continue
      hookSession(key, session)
      // 代次变化 = 同名会话已重建（新实例）：丢弃旧游标从 0 重读；即使暂无新数据也要上报（带 reset），
      // 让 server 立即清空该 key 的 rawBuf 并给订阅者下发清屏，不能依赖"新数据恰好非空"
      const prev = rawPosMap.get(key)
      const genChanged = !prev || prev.gen !== session.generation
      const raw = session.readRawStream(genChanged ? 0 : prev.pos)
      rawPosMap.set(key, { gen: session.generation, pos: raw.pos })
      if (raw.data || genChanged || raw.reset) {
        send({ type: "raw", sessionID, name, data: raw.data, pos: raw.pos, reset: genChanged || !!raw.reset, generation: session.generation })
      }
      if (!session.hasRunningStream()) continue
      const st = session.getRunningStream()
      if (st.data) send({ type: "out", sessionID, name, data: st.data })
    }
  }

  /**
   * 心跳检测：超过 HEARTBEAT_CLIENT_TIMEOUT_MS 未收到 server 的 ping，判定服务端半开，主动断开并触发重连。
   * 半开（socket 已死但本端不知）时 server 的 close 不会到达，只有本端超时才能发现并自愈。
   */
  const checkServerAlive = (): void => {
    if (closed || !ws) return
    if (Date.now() - lastPingAt <= HEARTBEAT_CLIENT_TIMEOUT_MS) return
    log.info(`代理心跳超时 ${HEARTBEAT_CLIENT_TIMEOUT_MS}ms 未收到服务端 ping，主动断开重连 ${wsUrl}`)
    try { ws.close() } catch { /* onclose 兜底重连 */ }
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
      connSeq += 1
      // 连接事件跨进程按"第 N 次 + 地址"合并（批量实例首连 connSeq 均为 1，合并为一行 + 计数）
      infoDedupShared(`agent-open:${wsUrl}:${connSeq}`, `代理已连接 ${wsUrl}（第 ${connSeq} 次）`, 10000)
      register()
      // WS 建立后（含重连）补齐 server 缺失的运行状态：发现某终端当前有正在运行的命令时，
      // 补播一次 cmdStart（携带命令文本），让 server 重建该终端的 streamBuf / busy 状态。
      // 原因：server 内存 streamBuf 可能随其重启丢失，或已按"无 agent"降级；不补播则 server
      // 手里没有运行状态，web 会显示"无 busy"。命令真实结束仍由生命周期 cmdDone 上报（当前 seq 标记）。
      const running: Array<{ sessionID: string; name: string; command: string }> = []
      const all: string[] = []
      for (const { sessionID, name } of listSessions()) {
        const k = `${sessionID}/${name}`
        all.push(k)
        const s = resolveSession(sessionID, name)
        if (!s?.hasRunningStream()) continue
        const command = s.getRunningCommand()
        if (!command) continue
        running.push({ sessionID, name, command })
        send({ type: "cmdStart", sessionID, name, command, ts: Date.now() })
      }
      const tag = connSeq > 1 ? "重连" : "首连"
      if (running.length) {
        log.info(`代理${tag}发现 ${running.length} 个运行中会话，已补播 cmdStart: ${running.map((r) => `${r.sessionID}/${r.name}`).join(", ")}`)
      } else {
        // 空态属周期性噪声，降到 debug（置 SSH_TOOL_DEBUG=1 才落盘）；仍带上本进程会话 key，便于按主会话 ID 关联
        debug(`代理${tag}未发现运行中会话（${wsUrl}）本进程会话: ${all.length ? all.join(", ") : "无"}`)
      }
      // 重连后清空 raw 游标：server 可能已重启（rawBuf 丢失）或本进程原地重连，
      // 首帧统一以"新代次"重发全量并带 reset，server 端 replace 语义保证不重复累积
      rawPosMap.clear()
      // 启动心跳检测：server 每 HEARTBEAT_INTERVAL_MS 下发 ping，本端回 pong 并据此刷新 lastPingAt；
      // 长时间收不到 ping（服务端半开）时由 checkServerAlive 主动断开重连
      if (hbTimer) { clearInterval(hbTimer); hbTimer = null }
      lastPingAt = Date.now()
      hbTimer = setInterval(checkServerAlive, HEARTBEAT_INTERVAL_MS)
      // 推流不再挂固定周期定时器：register() 已调度一次（挂接监听 + 推送初始 raw/reset），
      // 之后完全由数据到达事件驱动（见 schedulePush）。补播 cmdStart 见上，与推流周期无关。
    }
    ws.onmessage = (ev: MessageEvent) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(String(ev.data)) } catch { return }
      const t = msg.type as string | undefined
      if (!t) return
      // 应用层心跳：刷新存活时刻并回 pong（闭环即可，不触发重连）
      if (t === "ping") { lastPingAt = Date.now(); send({ type: "pong" }); return }
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
        // 兜底挂接监听：正常由 register()→pushStreams 挂接；此处确保命令真正执行前生命周期/数据监听已生效
        hookSession(key, session)
        const now = Date.now()
        const last = lastSubmitTs.get(key) ?? 0
        lastSubmitTs.set(key, now)
        // 排队序列执行中（队列非空）：新命令排队，等序列结束再执行；
        // 不能走 send（那是给交互程序的输入），也不能直接 exec（busy 期间 exec 会 quick-fail）
        if ((execQueue.get(key)?.length ?? 0) > 0) {
          execQueue.get(key)!.push(command)
          log.info(`agent run-exec 序列中排队 ${sid}/${name}: ${describeSend(command)} (队列 ${execQueue.get(key)!.length})`)
          return
        }
        if (session.hasRunningStream()) {
          if (now - last < INTERACTIVE_BUSY_MS) {
            const q = execQueue.get(key)
            if (q) q.push(command)
            else execQueue.set(key, [command])
            log.info(`agent run-exec 排队 ${sid}/${name}: ${describeSend(command)} (队列 ${(execQueue.get(key) ?? []).length})`)
            return
          }
          log.info(`agent run-exec busy 超阈值按交互输入 ${sid}/${name}: ${describeSend(command)}`)
          session.send(command + "\r")
          return
        }
        log.info(`agent run-exec 直接执行 ${sid}/${name}: ${describeSend(command)}`)
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
      if (pushTimer) { clearTimeout(pushTimer); pushTimer = null }
      if (hbTimer) { clearInterval(hbTimer); hbTimer = null }
      if (closed) return
      // 断开时记录受影响的终端列表；重连每 2s 重试一次，用 10s 窗口去重避免刷屏（重复次数附在汇总行）。
      // 去重键含受影响终端列表：同一批终端反复断连才合并，终端集合变化时立即另记一行，不丢会话归属信息。
      const keys = listSessions().map(({ sessionID, name }) => `${sessionID}/${name}`)
      infoDedup(
        `agent-close:${wsUrl}:${keys.join(",")}`,
        `代理连接断开（受影响终端: ${keys.length ? keys.join(", ") : "无"}），2s 后重连`,
        10000,
      )
      setTimeout(connect, 2000)
    }
    ws.onerror = () => { /* onclose 会触发重连 */ }
  }

  connect()

  return {
    close: () => {
      closed = true
      if (pushTimer) { clearTimeout(pushTimer); pushTimer = null }
      if (hbTimer) { clearInterval(hbTimer); hbTimer = null }
      try { ws?.close() } catch { /* ignore */ }
    },
    reRegister: register,
    transfer: (task) => { send({ type: "transfer", task }) },
  }
}
