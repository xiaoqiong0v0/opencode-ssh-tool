// HTTP 服务独立子进程管理：文件锁 + 端口探测 + detached 子进程，
// 服务不随任何 opencode 插件进程退出而关闭，多进程共享同一服务

import { mkdirSync, readFileSync, rmSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn, type ChildProcess } from "node:child_process"
import type { Lang } from "./i18n.js"

/** 服务句柄（独立进程托管，本进程无 ServerHandle） */
export interface ServerResult {
  server: null
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
/** 子进程启动后等待端口就绪的上限 */
const SPAWN_WAIT_MAX = 15000

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
 * 解析子进程解释器：
 * 1. 环境变量 SSH_TOOL_SERVER_BIN 显式指定
 * 2. process.execPath 是 node/bun 本体 → 直接复用（无需 PATH）
 * 3. 兜底用 PATH 上的 node（npm 安装 opencode 必然有 node 环境）
 */
function resolveInterpreter(): string {
  const fromEnv = process.env.SSH_TOOL_SERVER_BIN
  if (fromEnv) return fromEnv
  const base = basename(process.execPath).toLowerCase()
  if (base.includes("node") || base === "bun" || base === "bun.exe") return process.execPath
  return "node"
}

/** 子进程句柄缓存（进程退出后置空，供 ensureServer 复用判断） */
let serverProc: ChildProcess | null = null

/**
 * 启动独立服务子进程（detached：父进程退出不带走）
 * @param port 期望端口（0=随机；随机时端口由子进程决定并写入 server.json）
 * @param dir 缓存目录
 * @param lang Web 界面语言
 */
function spawnServerProc(port: number, dir: string, lang: Lang): void {
  // 子进程入口：本模块编译产物 dist/server-manager.js 同目录的 dist/server-entry.js
  const selfPath = fileURLToPath(import.meta.url)
  const entry = join(dirname(selfPath), "server-entry.js").replace(/\\/g, "/")
  const bin = resolveInterpreter()
  serverProc = spawn(bin, [entry, "--port", String(port), "--dir", dir, "--lang", lang], {
    detached: true,
    stdio: "ignore",
  })
  serverProc.unref()
  serverProc.on("exit", () => { serverProc = null })
}

/**
 * 确保 HTTP 服务单例运行（独立子进程，不随插件进程退出）：
 * 1. 有 server.json 且端口可探测 → 复用（reused=true）
 * 2. 否则拿文件锁（mkdir 原子）→ spawn 子进程 → 等端口就绪 → 释放锁
 * 3. 锁竞争失败 → 等待后重新探测复用
 * @param port 期望端口（0=随机，但随机端口无法跨进程复用，故随机时总是新启）
 * @param _getSessions 会话列表函数（独立进程内由服务自身从状态文件读取，此处无需）
 * @param dir 缓存目录（锁与信息文件存放处）
 * @param lang Web 界面语言（默认 en）
 * @returns 服务结果
 */
export async function ensureServer(
  port: number,
  _getSessions: () => unknown[],
  dir: string,
  lang: Lang = "en",
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
    // 3. 拿锁成功：启动独立服务子进程，等待端口就绪
    spawnServerProc(port, dir, lang)
    const deadline = Date.now() + SPAWN_WAIT_MAX
    while (Date.now() < deadline) {
      const info = readInfo(dir)
      if (info && (await probe(info.port))) {
        return { server: null, url: `http://127.0.0.1:${info.port}`, port: info.port, reused: false }
      }
      await new Promise((r) => setTimeout(r, 200))
    }
    return { server: null, url: "", port: 0, reused: false }
  } finally {
    try {
      rmSync(lockPath, { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
  }
}
