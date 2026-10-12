// 跨进程会话状态存储：各进程写状态文件到共享目录，web 服务聚合展示所有进程的会话

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import log from "./log.js"

/** 跨进程会话状态（写入共享目录供聚合） */
export interface SessionState {
  sessionID: string
  name: string
  /** 会话类型：ssh 远程 / local 本地·容器 */
  kind?: "ssh" | "local"
  host?: string
  user?: string
  port?: number
  /** 本地/容器会话的程序（如 pwsh、docker exec ...） */
  program?: string
  connected: boolean
  busy: boolean
  pending: number
  lastActive?: number
  connectedAt?: number
  title?: string
  directory?: string
  updatedAt: number
}

/** sessions 状态文件目录名 */
const SESSIONS_DIR = "sessions"

/** 状态文件名：<sessionID>-<name>.json（name 已 sanitize，安全） */
function stateFile(sessionsDir: string, sessionID: string, name: string): string {
  return join(sessionsDir, `${sessionID}-${name}.json`)
}

/**
 * 各状态文件上次记录的日志签名（`busy|connected|reason`）：内容未变时不再重复记。
 * 周期性的 session-meta 写入（每次仅 updatedAt 变化）会命中同一签名，从而不再刷屏；
 * 状态真正变化（busy/connected 翻转或写入原因不同）时照常记一行。
 */
const lastStateLog = new Map<string, string>()

/**
 * 写/更新某会话状态文件（进程内会话变化时调用）。
 * 状态文件是 server 拿不到 agent 实时流时 busy 的回退来源，故写入时记一行
 * （写入值 + 原因 + 目标终端）。日志**只在内容变化时记**：签名为 `busy|connected|reason`，
 * 与日志正文一致——重复写同样的值不再输出；状态翻转或原因变化才记。
 * @param cacheRoot 插件缓存根目录
 * @param state 会话状态（写入内容）
 * @param reason 写入原因（connect / exec前 / exec后 / send / session-meta 等）
 */
export function writeSessionState(cacheRoot: string, state: SessionState, reason = "sync"): void {
  try {
    const dir = join(cacheRoot, SESSIONS_DIR)
    mkdirSync(dir, { recursive: true })
    const file = stateFile(dir, state.sessionID, state.name)
    writeFileSync(file, JSON.stringify(state), "utf8")
    const sig = `${state.busy}|${state.connected}|${reason}`
    if (lastStateLog.get(file) === sig) return
    lastStateLog.set(file, sig)
    log.info(`[state] 写状态文件 ${state.sessionID}/${state.name} busy=${state.busy} connected=${state.connected} reason=${reason}`)
  } catch {
    /* 忽略写失败 */
  }
}

/** 删除某会话状态文件（断开/会话删除时调用） */
export function removeSessionState(cacheRoot: string, sessionID: string, name: string): void {
  try {
    const file = stateFile(join(cacheRoot, SESSIONS_DIR), sessionID, name)
    lastStateLog.delete(file)
    rmSync(file, { force: true })
  } catch {
    /* 忽略 */
  }
}

/** 删除某会话全部终端的状态文件（会话删除时调用，防残留） */
export function removeAllSessionStates(cacheRoot: string, sessionID: string): void {
  try {
    const dir = join(cacheRoot, SESSIONS_DIR)
    const prefix = `${sessionID}-`
    for (const f of readdirSync(dir)) {
      if (f.startsWith(prefix) && f.endsWith(".json")) {
        const file = join(dir, f)
        lastStateLog.delete(file)
        rmSync(file, { force: true })
      }
    }
  } catch {
    /* 忽略 */
  }
}

/** 聚合所有进程的会话状态（web 服务展示用），含标题/目录 */
export function listAllSessions(cacheRoot: string): SessionState[] {
  const dir = join(cacheRoot, SESSIONS_DIR)
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"))
  } catch {
    return []
  }
  const out: SessionState[] = []
  for (const f of files) {
    try {
      const s = JSON.parse(readFileSync(join(dir, f), "utf8")) as SessionState
      if (s && s.sessionID) out.push(s)
    } catch {
      /* 跳过损坏文件 */
    }
  }
  // 按连接时间排序（新的在前）
  out.sort((a, b) => (b.connectedAt ?? 0) - (a.connectedAt ?? 0))
  return out
}
