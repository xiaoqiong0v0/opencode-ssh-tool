// 跨进程会话状态存储：各进程写状态文件到共享目录，web 服务聚合展示所有进程的会话

import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
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

/** 原子写临时文件序号：同进程同一毫秒内多次写也能得到唯一临时名 */
let tmpSeq = 0

/**
 * 原子写 JSON 文件：先在**同目录**写唯一命名的临时文件，fsync 落盘后再 `rename` 覆盖目标。
 * 这样读方（server 聚合读状态文件、各实例读 server.json）**永远读不到半截内容**——
 * 要么读到旧的完整内容，要么读到新的完整内容，消除"先 truncate 再写"造成的瞬时损坏
 * （读方 try/catch 只能跳过损坏文件，表现为瞬时漏一条）。
 * 失败时**不抛异常**（调用方不崩）：清理临时文件、**保留旧文件**、记一行 warn 日志并返回 false。
 * 取舍：Windows 下若目标正被其他进程以打开句柄持有，`rename` 可能瞬时 EPERM 而失败——
 * 此时保留旧文件即安全（下次写会重试），故**不做**"先删除目标再 rename"的退化写法
 * （那会引入文件短暂不存在的窗口，反而更差）；目录 fsync 在 Windows 不可用，忽略即可。
 * @param file 目标文件路径（其父目录须已存在，由调用方保证）
 * @param data 待写入对象（JSON.stringify 默认形态，与原直写行为一致）
 * @returns 是否写入成功（true=新内容已原子生效；false=失败并保留旧文件）
 */
export function atomicWriteJson(file: string, data: unknown): boolean {
  const tmp = `${file}.${process.pid}.${Date.now()}.${tmpSeq++}.tmp`
  try {
    const fd = openSync(tmp, "w")
    try {
      writeFileSync(fd, JSON.stringify(data), "utf8")
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    // 目录项 fsync：Unix 上保证 rename 结果持久化；Windows 打开目录/fsync 会 EPERM，catch 忽略
    try {
      const dfd = openSync(dirname(file), "r")
      try { fsyncSync(dfd) } finally { closeSync(dfd) }
    } catch {
      /* 目录 fsync 在部分平台不可用（如 Windows），忽略 */
    }
    renameSync(tmp, file)
    return true
  } catch (e) {
    try { rmSync(tmp, { force: true }) } catch { /* 临时文件清理失败忽略 */ }
    log.warn(`[state] 原子写失败，保留旧文件 ${file}`, e instanceof Error ? e : String(e))
    return false
  }
}

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
    // 原子写：失败时保留旧文件且不记"已写"日志（与原 catch 静默口径一致，避免日志与实况不符）
    if (!atomicWriteJson(file, state)) return
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
