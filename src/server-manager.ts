// HTTP 服务独立子进程管理：文件锁 + 端口探测 + detached 子进程，
// 服务不随任何 opencode 插件进程退出而关闭，多进程共享同一服务。
// 服务版本由 server.json 的 proto 字段标识，版本不符时杀掉旧进程重启，防止持久进程跑旧代码。

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn, type ChildProcess } from "node:child_process"
import { createServer } from "node:net"
import type { Lang } from "./i18n.js"
import { SERVER_PROTO_VERSION } from "./constants.js"
import log from "./log.js"

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
  /** 服务协议/代码版本：与当前 SERVER_PROTO_VERSION 不一致视为旧实例，复用前杀掉重启 */
  proto?: number
}

const LOCK_DIR = "server.lock"
const INFO_FILE = "server.json"
/** 锁目录内的属主信息文件名（pid + 创建时间，用于判定陈旧锁） */
const LOCK_OWNER = "owner.json"
/** 锁存在但无属主信息（崩溃于 mkdir 与写属主之间）时，超过此毫秒视为陈旧 */
const LOCK_NOINFO_STALE_MS = 5_000
/** 锁存在且有属主信息、但持有者长时间未完成启动时的绝对陈旧上限（启动上限 SPAWN_WAIT_MAX=15s） */
const LOCK_ABS_STALE_MS = 60_000
const PROBE_TIMEOUT = 800
const LOCK_WAIT_MAX = 5000
/** 子进程启动后等待端口就绪的上限 */
const SPAWN_WAIT_MAX = 15000
/** 杀旧进程后等待端口释放的上限 */
const KILL_WAIT_MAX = 4000

/**
 * 本进程内"某个期望端口"的一次确保结果（Promise 复用）：
 * - 成功：后续同端口调用直接复用已起服务，不再 spawn
 * - 失败（固定端口绑定被拒 / 锁竞争 / 启动超时）：收敛为同一失败结果，同端口不再重试（不刷屏、不反复起进程）
 * 端口变化视为一次显式新请求，替换缓存。
 */
let cachedEnsure: { port: number; promise: Promise<ServerResult> } | null = null

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

/**
 * 读取端口上服务 /health 自证的身份（其自身进程 pid），用于终止前校验归属。
 * 取不到 / 超时 / 响应非 2xx / 响应体异常 / 无 pid 字段均返回 null，表示"身份未知"。
 * @param port 待探测端口
 * @returns 服务自报 pid；无法确认时返回 null
 */
async function probeServerPid(port: number): Promise<number | null> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT)
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctrl.signal })
    clearTimeout(timer)
    if (!r.ok) return null
    const body = (await r.json()) as { pid?: unknown }
    return typeof body?.pid === "number" ? body.pid : null
  } catch {
    return null
  }
}

/**
 * 预检端口在本机 127.0.0.1 能否绑定（快速失败）：
 * 固定端口落在系统保留区间时立即得到 EACCES，无需 spawn 子进程后干等启动超时。
 * @param port 待检查端口（仅用于固定端口，>0）
 * @returns 可绑定返回 null；否则返回错误码（如 EACCES / EADDRINUSE）
 */
function probeBindable(port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once("error", (e) => resolve((e as NodeJS.ErrnoException).code ?? "UNKNOWN"))
    srv.listen(port, "127.0.0.1", () => {
      srv.close(() => resolve(null))
    })
  })
}

/** 读取服务信息文件（可能不存在） */
function readInfo(dir: string): ServerInfo | null {
  try {
    return JSON.parse(readFileSync(join(dir, INFO_FILE), "utf8")) as ServerInfo
  } catch {
    return null
  }
}

/** 该服务实例代码/协议是否与当前版本一致（无 proto 字段视为旧实例） */
function isCurrentVersion(info: ServerInfo | null): boolean {
  return info != null && info.proto === SERVER_PROTO_VERSION
}

/** 锁属主信息（进程 pid + 创建时间） */
interface LockOwner {
  pid: number
  ts: number
}

/**
 * 进程是否存活（signal 0 探测；EPERM 表示存在但无权限，视为存活）
 * @param pid 进程号
 * @returns 是否存活
 */
function isAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** 读取锁属主信息（缺失/损坏返回 null） */
function readLockOwner(lockPath: string): LockOwner | null {
  try {
    const o = JSON.parse(readFileSync(join(lockPath, LOCK_OWNER), "utf8")) as LockOwner
    return typeof o?.pid === "number" ? o : null
  } catch {
    return null
  }
}

/**
 * 清理陈旧服务锁：持有者崩溃/被 kill 不会走 finally 释放锁，必须能自愈，
 * 否则残留的 server.lock 目录会让后续 ensureServer 永远拿不到锁、服务再也起不来。
 * 判定：有属主信息 → 属主进程已死或锁超绝对上限；无属主信息 → 超过 LOCK_NOINFO_STALE_MS。
 * @param lockPath 锁目录路径
 * @returns 是否已清理（锁不存在也返回 false，交由调用方重试 mkdir）
 */
function clearStaleLock(lockPath: string): boolean {
  let mtime = 0
  try {
    mtime = statSync(lockPath).mtimeMs
  } catch {
    return false // 锁已不存在
  }
  const owner = readLockOwner(lockPath)
  const age = Date.now() - (owner?.ts ?? mtime)
  const stale = owner
    ? !isAlive(owner.pid) || age > LOCK_ABS_STALE_MS
    : age > LOCK_NOINFO_STALE_MS
  if (!stale) return false
  try {
    rmSync(lockPath, { recursive: true, force: true })
  } catch {
    return false
  }
  log.info(`清理陈旧服务锁 server.lock（属主 pid=${owner?.pid ?? "?"}，age=${Math.round(age / 1000)}s）`)
  return true
}

/**
 * 尝试获取服务锁（mkdir 原子）：创建成功则写入属主信息；
 * 失败先尝试清理陈旧锁再重试一次（持有者崩溃的场景）。
 * @param dir 缓存目录
 * @returns 是否拿到锁
 */
function acquireLock(dir: string): boolean {
  const lockPath = join(dir, LOCK_DIR)
  const create = (): boolean => {
    try {
      mkdirSync(lockPath)
    } catch {
      return false
    }
    try {
      writeFileSync(join(lockPath, LOCK_OWNER), JSON.stringify({ pid: process.pid, ts: Date.now() }), "utf8")
    } catch {
      /* 属主信息写失败不影响持锁，仅失去陈旧判定依据 */
    }
    return true
  }
  if (create()) return true
  if (!clearStaleLock(lockPath)) return false
  return create()
}

/**
 * 杀掉可能仍在运行的旧服务进程并等待端口释放（跨平台，不依赖 lsof/wmic）：
 * detached 子进程不随插件进程退出，升级后旧进程可能仍占住端口，
 * 必须显式 kill 后再 spawn，否则新进程 bind 失败。
 * 杀之前先向 info.port 取 /health 自证身份：仅当响应 pid 与 info.pid 一致才发 SIGTERM，
 * 防止 server.json 残留的 pid 已被系统回收给无关进程时误杀。
 * /health 取不到、超时、响应异常、pid 缺失或不匹配 → 一律不杀（宁可留僵尸元数据，也不误杀），
 * 残留元数据（server.json / 陈旧锁）交由既有清理路径处理，随后继续启动新服务。
 * @param info 服务信息（含 pid/port）
 */
async function killStale(info: ServerInfo | null): Promise<void> {
  if (!info) return
  const selfPid = await probeServerPid(info.port)
  if (selfPid === null || selfPid !== info.pid) {
    log.info(
      `跳过终止 pid=${info.pid}：其不在我们的端口 ${info.port} 上服务 / pid 归属不符（端口自报 pid=${selfPid ?? "未知"}），仅清理残留元数据`,
    )
    return
  }
  try {
    process.kill(info.pid, "SIGTERM")
  } catch {
    // 进程可能已退出或无权 kill，交由端口探测判断
  }
  const deadline = Date.now() + KILL_WAIT_MAX
  while (Date.now() < deadline) {
    if (!(await probe(info.port))) return
    await new Promise((r) => setTimeout(r, 200))
  }
}

/** 失败结果：url 为空串，调用方据此判定服务不可用（命令执行不受影响） */
function failedResult(): ServerResult {
  return { server: null, url: "", port: 0, reused: false }
}

/**
 * 确保 HTTP 服务可用（进程内按端口缓存一次尝试，成功复用、失败收敛，绝不抛错）：
 * 同端口重复调用直接复用同一 Promise —— 成功不再 spawn，失败不再重试（不刷屏、不反复起进程）。
 * @param port 期望端口（0=自动分配；>0=固定端口，绑定被拒时直接放弃、不回退不重试）
 * @param getSessions 会话列表函数（独立进程内由服务自身从状态文件读取，此处无需）
 * @param dir 缓存目录（锁与信息文件存放处）
 * @param lang Web 界面语言（默认 en）
 * @returns 服务结果（url 为空串即不可用）
 */
export function ensureServer(
  port: number,
  getSessions: () => unknown[],
  dir: string,
  lang: Lang = "en",
): Promise<ServerResult> {
  if (cachedEnsure && cachedEnsure.port === port) return cachedEnsure.promise
  const promise = ensureServerOnce(port, getSessions, dir, lang).catch((e) => {
    log.error("确保 HTTP 服务失败", e instanceof Error ? e : String(e))
    return failedResult()
  })
  cachedEnsure = { port, promise }
  return promise
}

/**
 * 单次确保 HTTP 服务单例运行（独立子进程，不随插件进程退出）：
 * 1. 有 server.json 且端口可探测、proto 为当前版本 → 复用（reused=true）
 *    proto 不符或探测失败 → 杀旧进程后走 spawn 新服务
 * 2. 否则拿文件锁（mkdir 原子）→ spawn 子进程 → 等端口就绪 → 释放锁
 * 3. 锁竞争失败 → 等待后重新探测复用（同样校验版本，新旧并存时杀旧）
 * 4. 固定端口（>0）：spawn 前预检可绑定；绑定被拒或子进程启动即退出 → 立即失败，不换端口、不重试
 * @param port 期望端口（0=随机，但随机端口无法跨进程复用，故随机时总是新启）
 * @param _getSessions 会话列表函数（独立进程内由服务自身从状态文件读取，此处无需）
 * @param dir 缓存目录（锁与信息文件存放处）
 * @param lang Web 界面语言（默认 en）
 * @returns 服务结果（url 为空串即不可用）
 */
async function ensureServerOnce(
  port: number,
  _getSessions: () => unknown[],
  dir: string,
  lang: Lang = "en",
): Promise<ServerResult> {
  mkdirSync(dir, { recursive: true })

  // 1. 探测既有服务（固定端口场景可复用；旧版本实例不复用，杀旧后新启）
  if (port > 0) {
    const info = readInfo(dir)
    if (isCurrentVersion(info) && info!.port === port && (await probe(port))) {
      return { server: null, url: `http://127.0.0.1:${port}`, port, reused: true }
    }
    if (info && info.port === port && (await probe(port)) && !isCurrentVersion(info)) {
      log.info(`检测到旧版服务 pid=${info.pid}（proto ${info.proto ?? "?"}），重启独立服务`)
      await killStale(info)
    }
  }

  // 2. 尝试拿锁（mkdir 原子操作：谁先创建成功谁启动）；陈旧锁（持有者崩溃残留）自动清理后重试
  const lockPath = join(dir, LOCK_DIR)
  let acquired = acquireLock(dir)
  if (!acquired) {
    // 锁被活跃持有者占用：等待其启动服务；期间锁若变陈旧（持有者退出）则抢占
    const deadline = Date.now() + LOCK_WAIT_MAX
    while (Date.now() < deadline && !acquired) {
      await new Promise((r) => setTimeout(r, 200))
      const info = readInfo(dir)
      if (info && isCurrentVersion(info) && (await probe(info.port))) {
        return { server: null, url: `http://127.0.0.1:${info.port}`, port: info.port, reused: true }
      }
      if (info && !isCurrentVersion(info) && (await probe(info.port))) {
        await killStale(info)
      }
      acquired = acquireLock(dir)
    }
    if (!acquired) return failedResult()
  }

  try {
    // 3. 拿锁成功：先清残留旧进程（可能 pid 已退出或锁内刚杀掉），再启动新版
    const leftover = readInfo(dir)
    if (leftover && !isCurrentVersion(leftover)) await killStale(leftover)

    // 固定端口：spawn 前预检可绑定，绑定被拒（如 Windows 保留区间 EACCES）立即失败，不回退不重试
    if (port > 0) {
      const code = await probeBindable(port)
      if (code) {
        log.error(`固定端口 ${port} 绑定失败（${code}），固定端口不回退不重试；Web 记录服务不可用，命令执行不受影响`)
        return failedResult()
      }
    }

    const child = spawnServerProc(port, dir, lang)
    const deadline = Date.now() + SPAWN_WAIT_MAX
    while (Date.now() < deadline) {
      // 子进程启动即退出（绑定被拒/端口被抢占等）→ 立即判定失败，不干等满 15s
      if (child.exitCode !== null || child.signalCode !== null) {
        log.error(`独立服务子进程启动即退出（端口 ${port}），Web 记录服务不可用，命令执行不受影响`)
        return failedResult()
      }
      const info = readInfo(dir)
      if (info && isCurrentVersion(info) && (await probe(info.port))) {
        return { server: null, url: `http://127.0.0.1:${info.port}`, port: info.port, reused: false }
      }
      await new Promise((r) => setTimeout(r, 200))
    }
    log.error(`独立服务启动超时（端口 ${port}），Web 记录服务不可用，命令执行不受影响`)
    return failedResult()
  } finally {
    try {
      rmSync(lockPath, { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
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

/**
 * 启动独立服务子进程（detached：父进程退出不带走）
 * @param port 期望端口（0=随机；随机时端口由子进程决定并写入 server.json）
 * @param dir 缓存目录
 * @param lang Web 界面语言
 * @returns 子进程句柄（调用方据此监测是否启动即退出）
 */
function spawnServerProc(port: number, dir: string, lang: Lang): ChildProcess {
  // 子进程入口：本模块编译产物 dist/server-manager.js 同目录的 dist/server-entry.js
  const selfPath = fileURLToPath(import.meta.url)
  const entry = join(dirname(selfPath), "server-entry.js").replace(/\\/g, "/")
  const bin = resolveInterpreter()
  const child = spawn(bin, [entry, "--port", String(port), "--dir", dir, "--lang", lang], {
    detached: true,
    stdio: "ignore",
  })
  child.unref()
  return child
}