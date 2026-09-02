// 跨进程会话状态存储：各进程写状态文件到共享目录，web 服务聚合展示所有进程的会话

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** 跨进程会话状态（写入共享目录供聚合） */
export interface SessionState {
  sessionID: string
  name: string
  host?: string
  user?: string
  port?: number
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

/** 写/更新某会话状态文件（进程内会话变化时调用） */
export function writeSessionState(cacheRoot: string, state: SessionState): void {
  try {
    const dir = join(cacheRoot, SESSIONS_DIR)
    mkdirSync(dir, { recursive: true })
    writeFileSync(stateFile(dir, state.sessionID, state.name), JSON.stringify(state), "utf8")
  } catch {
    /* 忽略写失败 */
  }
}

/** 删除某会话状态文件（断开/会话删除时调用） */
export function removeSessionState(cacheRoot: string, sessionID: string, name: string): void {
  try {
    rmSync(stateFile(join(cacheRoot, SESSIONS_DIR), sessionID, name), { force: true })
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
