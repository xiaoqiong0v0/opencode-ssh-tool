// 独立 HTTP 服务子进程入口：脱离任何 opencode 插件进程存活，
// 从状态文件+历史文件读取会话数据，并接受插件进程作为"代理"注册以转发交互命令。

import { startServer, type SessionEntry } from "./server.js"
import { atomicWriteJson } from "./session-store.js"
import { loadConfig } from "./config.js"
import { getWebLang } from "./i18n.js"
import { SERVER_PROTO_VERSION } from "./constants.js"
import { join } from "node:path"
import log from "./log.js"

const INFO_FILE = "server.json"

/** 解析 --key value 形式参数 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main(): Promise<void> {
  const cfg = loadConfig()
  const portArg = arg("port")
  const port = portArg ? parseInt(portArg, 10) : cfg.server.port
  const dir = arg("dir") ?? ""
  // Web 界面语言：--lang（插件传入的 webLang）优先，否则 SSH_WEB_LANG / 配置 webLang
  const lang = arg("lang") === "zh" ? "zh" : arg("lang") === "en" ? "en" : getWebLang(cfg.webLang)
  const streamTickMs = cfg.server.streamTickMs ?? 100
  const idleShutdownMs = cfg.server.idleShutdownMs ?? 0

  const getSessions = (): SessionEntry[] => []

  const handle = await startServer(port, getSessions, dir, lang, streamTickMs)

  // 写服务信息文件（供其他进程探测复用；proto 标识代码/协议版本，版本不符会触发重启）
  // 原子写：其他实例可能在并发读 server.json，避免读到半截 JSON
  atomicWriteJson(join(dir, INFO_FILE), { port: handle.port, host: "127.0.0.1", pid: process.pid, startedAt: Date.now(), proto: SERVER_PROTO_VERSION })

  log.info(`独立服务启动 ${handle.url} (pid ${process.pid}, proto ${SERVER_PROTO_VERSION})，内存流缓冲 streamBuf 初始为空（新进程不复用旧内存，旧进程追踪中的命令状态需 agent 重连后重新上报）`)

  // 空闲自动关闭：改为**事件驱动**——不再每 tick 读状态文件（I/O），也不受残留状态文件 connected=true 影响
  // （旧实现因此永不空闲）。空闲判定 = "是否还有 agent 连接"（等价于"是否还有插件进程在用本服务"）：
  // 最后一个 agent 断开时启动计时，任一 agent 连接即取消；全程无 agent 时按同一超时关闭。
  if (idleShutdownMs > 0) {
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    /** 启动（重置）空闲关闭计时器：到点仍无 agent 连接则关闭本服务 */
    const scheduleIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        log.info(`空闲超过 ${idleShutdownMs}ms（无 agent 连接），独立服务自动关闭`)
        handle.close()
        process.exit(0)
      }, idleShutdownMs)
    }
    handle.onAgentPresence((present) => {
      if (present) {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
        return
      }
      scheduleIdle()
    })
  }

  const shutdown = (): void => {
    try { handle.close() } catch { /* ignore */ }
    process.exit(0)
  }
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)
}

main().catch((e) => {
  log.error("独立服务启动失败", e instanceof Error ? e.message : String(e))
  process.exit(1)
})
