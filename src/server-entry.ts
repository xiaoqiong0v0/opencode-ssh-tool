// 独立 HTTP 服务子进程入口：脱离任何 opencode 插件进程存活，
// 从状态文件+历史文件读取会话数据，并接受插件进程作为"代理"注册以转发交互命令。

import { startServer, type SessionEntry } from "./server.js"
import { listAllSessions } from "./session-store.js"
import { loadConfig } from "./config.js"
import { getLang } from "./i18n.js"
import { writeFileSync } from "node:fs"
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
  const lang = arg("lang") === "zh" ? "zh" : getLang(cfg.webLang)
  const streamTickMs = cfg.server.streamTickMs ?? 100
  const idleShutdownMs = cfg.server.idleShutdownMs ?? 0

  const getSessions = (): SessionEntry[] => []

  const handle = await startServer(port, getSessions, dir, lang, streamTickMs)

  // 写服务信息文件（供其他进程探测复用）
  writeFileSync(
    join(dir, INFO_FILE),
    JSON.stringify({ port: handle.port, host: "127.0.0.1", pid: process.pid, startedAt: Date.now() }),
    "utf8",
  )

  log.info(`独立服务启动 ${handle.url} (pid ${process.pid})`)

  // 空闲自动关闭：无任何 connected 会话持续 idleShutdownMs 后退出（0=不关闭）
  if (idleShutdownMs > 0) {
    let idleSince = Date.now()
    setInterval(() => {
      const anyConnected = listAllSessions(dir).some((s) => s.connected)
      if (anyConnected) {
        idleSince = Date.now()
        return
      }
      if (Date.now() - idleSince >= idleShutdownMs) {
        log.info(`空闲超过 ${idleShutdownMs}ms，独立服务自动关闭`)
        handle.close()
        process.exit(0)
      }
    }, Math.min(30000, Math.max(5000, idleShutdownMs)))
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
