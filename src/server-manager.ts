// HTTP 服务跨进程单例管理：文件锁 + 端口探测，避免多会话/多进程重复启动服务

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { startServer, type ServerHandle, type SessionEntry } from "./server.js"

/** 服务句柄（含是否复用既有服务） */
export interface ServerResult {
  server: ServerHandle | null
  /** 实际地址 */
  url: string
  /** 实际端口 */
  port: number
  /** 是否复用了已存在的服务（非本进程启动） */
  reused: boolean
}

/** 服务信息文件（记录已启动服务的端口，供其他进程探测复用） */
interface ServerInfo {
  port: number
  host: string
  pid: number
  startedAt: number
}

const LOCK_DIR = "server.lock"
const INFO_FILE = "server.json"
const PROBE_TIMEOUT = 800
const LOCK_WAIT_MAX = 5000

/** 探测某端口 /health 是否可达（判断服务是否已运行） */
async function probe(port: number): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT)
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctrl.signal })
    clearTimeout(timer)
    return r.ok
  } catch {
    return false
  }
}

/** 读取服务信息文件（可能不存在） */
function readInfo(dir: string): ServerInfo | null {
  try {
    return JSON.parse(readFileSync(join(dir, INFO_FILE), "utf8")) as ServerInfo
  } catch {
    return null
  }
}

/**
 * 确保 HTTP 服务单例运行：
 * 1. 有 server.json 且端口可探测 → 复用（reused=true）
 * 2. 否则拿文件锁（mkdir 原子）→ 启动 → 写 server.json → 释放锁
 * 3. 锁竞争失败 → 等待后重新探测复用
 * @param port 期望端口（0=随机，但随机端口无法跨进程复用，故随机时总是新启）
 * @param getSessions 会话列表函数
 * @param dir 缓存目录（锁与信息文件存放处）
 * @returns 服务结果
 */
export async function ensureServer(
  port: number,
  getSessions: () => SessionEntry[],
  dir: string,
): Promise<ServerResult> {
  mkdirSync(dir, { recursive: true })

  // 1. 探测既有服务（固定端口场景可复用）
  if (port > 0) {
    const info = readInfo(dir)
    if (info && info.port === port && (await probe(port))) {
      return { server: null, url: `http://127.0.0.1:${port}`, port, reused: true }
    }
  }

  // 2. 尝试拿锁（mkdir 原子操作：谁先创建成功谁启动）
  const lockPath = join(dir, LOCK_DIR)
  try {
    mkdirSync(lockPath)
  } catch {
    // 锁被占用：等待后探测
    const deadline = Date.now() + LOCK_WAIT_MAX
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200))
      const info = readInfo(dir)
      if (info && (await probe(info.port))) {
        return { server: null, url: `http://127.0.0.1:${info.port}`, port: info.port, reused: true }
      }
    }
    return { server: null, url: "", port: 0, reused: false }
  }

  try {
    // 3. 拿锁成功：启动服务
    const handle = await startServer(port, getSessions, dir)
    // 写服务信息（供其他进程探测复用）
    writeFileSync(
      join(dir, INFO_FILE),
      JSON.stringify({ port: handle.port, host: "127.0.0.1", pid: process.pid, startedAt: Date.now() } satisfies ServerInfo),
      "utf8",
    )
    return { server: handle, url: handle.url, port: handle.port, reused: false }
  } finally {
    // 释放锁
    try {
      rmSync(lockPath, { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
  }
}
