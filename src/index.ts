// 插件入口：导出 5 个 SSH 工具 + 会话生命周期管理 + HTTP 终端记录服务

import { tool, type Plugin } from "@opencode-ai/plugin"
import createLogger from "@xiaoqiong0v0/opencode-plugin-logger"
import { CACHE_DIR } from "./constants.js"
import { homedir } from "node:os"
import { join } from "node:path"
import { rmSync } from "node:fs"
import { loadConfig } from "./config.js"
import { SessionHistory } from "./history.js"
import { T, getLang, tr } from "./i18n.js"
import { createDecider } from "./permission.js"
import { SshSession, type SessionStatus } from "./session.js"
import { startServer, type ServerHandle, type SessionEntry } from "./server.js"

const log = createLogger("opencode-ssh-tool")

/** 默认终端名（不传 name 时用） */
const DEFAULT_NAME = "default"

/** 终端名合法字符（字母/数字/下划线/中划线/点），防止路径穿越 */
const NAME_RE = /^[A-Za-z0-9_.-]+$/

/**
 * 校验并规整终端名（防路径穿越：拒绝 ../、绝对路径、路径分隔符）
 * @param name 原始终端名
 * @returns 合法则返回本身；非法则返回 null
 */
function sanitizeName(name: string): string | null {
  if (!name || name.length > 64 || !NAME_RE.test(name)) return null
  if (name === "." || name === "..") return null
  return name
}

/** 会话表：key = opencode sessionID → 内层 key = 终端名 → SshSession */
export const sshSessions = new Map<string, Map<string, SshSession>>()

/** 会话元信息（标题/目录，供 HTTP 页面显示），key = sessionID */
const sessionMeta = new Map<string, { title: string; directory: string }>()

/** HTTP 终端记录服务句柄（可能未启用） */
let httpServer: ServerHandle | null = null

/** 进程退出兜底：关闭全部连接 */
process.on("exit", () => {
  for (const map of sshSessions.values()) for (const s of map.values()) s.close()
})

/** 按 sessionID 取内层终端表（无则返回 undefined） */
function getSessionMap(sessionID: string): Map<string, SshSession> | undefined {
  return sshSessions.get(sessionID)
}

/** 按 sessionID + 终端名取会话（name 默认 default） */
function getSession(sessionID: string, name = DEFAULT_NAME): SshSession | undefined {
  return getSessionMap(sessionID)?.get(name)
}

/** 扁平化会话条目列表（供 HTTP 服务展示） */
function listSessionEntries(): SessionEntry[] {
  const entries: SessionEntry[] = []
  for (const [sessionID, map] of sshSessions) {
    const meta = sessionMeta.get(sessionID)
    for (const [name, session] of map) entries.push({ sessionID, name, session, title: meta?.title, directory: meta?.directory })
  }
  return entries
}

/** 插件缓存根目录（历史消息对存文件，随会话清理） */
function cacheRoot(): string {
  const home = process.env.USERPROFILE || process.env.HOME || homedir()
  return join(home, CACHE_DIR)
}

/** 清理指定会话（一个终端）：关闭连接 + 删缓存目录 + 从会话表移除 */
function cleanupSession(sessionID: string, name = DEFAULT_NAME): void {
  const map = getSessionMap(sessionID)
  const session = map?.get(name)
  if (session) {
    session.close() // 内部会 history.dispose() 删除缓存目录
    map!.delete(name)
    if (map!.size === 0) sshSessions.delete(sessionID)
  } else {
    // 无活动连接：直接删该终端缓存目录（如有残留）
    try {
      rmSync(join(cacheRoot(), sessionID, name), { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
  }
}

/** 清理一个 sessionID 下全部终端 */
function cleanupAllSessions(sessionID: string): void {
  const map = getSessionMap(sessionID)
  if (map) {
    for (const s of map.values()) s.close()
    sshSessions.delete(sessionID)
  } else {
    try {
      rmSync(join(cacheRoot(), sessionID), { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
  }
}

export const OpenCodeSshTool: Plugin = async () => {
  log.loaded()

  // 加载配置并启动 HTTP 终端记录服务（默认开启；端口 0=自动分配）
  const cfg = loadConfig()
  // 语言：环境变量 SSH_TOOL_LANG 优先，否则配置文件 toolLang（默认 en）
  const lang = getLang(cfg.toolLang)
  // 权限判定器：内置正则 + 配置自定义 deny/allow 正则
  const decide = createDecider(cfg.permission.deny, cfg.permission.allow)
  if (cfg.server.enabled) {
    try {
      httpServer = await startServer(cfg.server.port, listSessionEntries)
      log.info(`HTTP 服务已启动 ${httpServer.url}`)
    } catch (e) {
      log.error("HTTP 服务启动失败", e instanceof Error ? e : String(e))
    }
  } else {
    log.info("HTTP 服务未启用（配置 server.enabled=false）")
  }

  return {
    event: async ({ event }) => {
      // 会话创建/更新时记录标题与目录（供 HTTP 页面显示会话名称）
      if (event.type === "session.created" || event.type === "session.updated") {
        const info = (event as { properties?: { info?: { id?: string; title?: string; directory?: string } } }).properties?.info
        if (info?.id) {
          sessionMeta.set(info.id, { title: info.title ?? "", directory: info.directory ?? "" })
        }
      }
      // 会话删除时清理：关闭全部终端连接 + 删缓存目录 + 删元信息
      if (event.type === "session.deleted") {
        const info = (event as { properties?: { info?: { id?: string } } }).properties?.info
        const sid = info?.id
        if (sid) {
          cleanupAllSessions(sid)
          sessionMeta.delete(sid)
          log.info(`会话 ${sid} 删除，已清理`)
        }
      }
    },
    tool: {
      ssh_connect: tool({
        description: T.ssh_connect[lang],
        args: {
          host: tool.schema.string().describe(T.ssh_connect_args.host[lang]),
          user: tool.schema.string().describe(T.ssh_connect_args.user[lang]),
          port: tool.schema.number().optional().describe(T.ssh_connect_args.port[lang]),
          name: tool.schema.string().optional().describe(T.ssh_connect_args.name[lang]),
        },
        async execute(args, context) {
          const { sessionID } = context
          const name = args.name ?? DEFAULT_NAME
          if (sanitizeName(name) === null) {
            return tr("invalid_name", lang)
          }
          try {
            await context.ask({
              permission: "ssh_connect",
              patterns: [`${args.user}@${args.host}:${args.port ?? 22}`],
              always: [`ssh_connect:${args.user}@${args.host}:${args.port ?? 22}`],
              metadata: { title: `${args.user}@${args.host}` },
            })
          } catch {
            return tr("rejected_connect", lang)
          }

          // 同名终端已有连接 → 先关旧的
          const map = getSessionMap(sessionID)
          const old = map?.get(name)
          if (old) {
            old.close()
            map!.delete(name)
          }

          const session = new SshSession(sessionID, new SessionHistory(join(cacheRoot(), sessionID), name, cfg.history.maxMessages), name)
          const result = await session.connect(args)
          log.tool("ssh_connect", { host: args.host, user: args.user, port: args.port ?? 22, name })

          if (!result.ok) {
            session.close() // 关闭连接 + 清理 history 缓存目录
            return {
              title: tr("connect_title_fail", lang),
              output: result.error ?? tr("unknown_error", lang),
            }
          }

          if (!map) sshSessions.set(sessionID, new Map())
          sshSessions.get(sessionID)!.set(name, session)
          return {
            title: `${tr("connect_title_ok", lang)} ${args.user}@${args.host}`,
            output: tr("connect_ok", lang)
              .replace("{user}", args.user)
              .replace("{host}", args.host)
              .replace("{port}", String(args.port ?? 22))
              .replace("{sid}", sessionID)
              .replace("{name}", name),
            metadata: { host: args.host, user: args.user, port: args.port ?? 22, name },
          }
        },
      }),

      ssh_exec: tool({
        description: T.ssh_exec[lang],
        args: {
          command: tool.schema.string().describe(T.ssh_exec_args.command[lang]),
          waitResult: tool.schema.boolean().optional().describe(T.ssh_exec_args.waitResult[lang]),
          name: tool.schema.string().optional().describe(T.ssh_exec_args.name[lang]),
        },
        async execute(args, context) {
          const { sessionID } = context
          const session = getSession(sessionID, args.name)
          if (!session) return tr("not_connected", lang)

          // 权限判定：先黑后白再问
          const decision = decide(args.command)
          if (decision === "deny") {
            log.tool("ssh_exec_denied", { command: args.command })
            return tr("denied_danger", lang)
          }
          if (decision === "ask") {
            log.info(`[ask] 命令需审批，调用 context.ask: ${args.command.slice(0, 60)}`)
            try {
              await context.ask({
                permission: "ssh_exec",
                patterns: [args.command],
                always: [`ssh_exec:${args.command}`],
                metadata: { title: args.command.slice(0, 60) },
              })
              log.info(`[ask] context.ask 返回（已允许）: ${args.command.slice(0, 60)}`)
            } catch {
              log.info(`[ask] context.ask 抛异常（已拒绝）: ${args.command.slice(0, 60)}`)
              return tr("denied", lang)
            }
          }

          // 默认异步提交（立即返回，不占上下文）；waitResult=true 同步等结果
          const result = args.waitResult ? await session.exec(args.command) : await session.submit(args.command)
          log.tool("ssh_exec", { command: args.command, ok: result.ok, submitted: result.submitted, interactive: result.interactive, running: result.running })

          const meta: Record<string, string | number | boolean | undefined> = {
            host: result.host,
            command: result.command,
            duration: result.duration,
            submitted: result.submitted,
            interactive: result.interactive,
            running: result.running,
            timeout: result.timeout,
          }
          if (result.submitted) {
            return { title: tr("exec_title", lang).replace("{cmd}", args.command.slice(0, 60)), output: tr("submitted", lang), metadata: meta }
          }
          return {
            title: tr("exec_title", lang).replace("{cmd}", args.command.slice(0, 60)),
            output: result.ok ? result.output : result.error ?? tr("exec_failed", lang),
            metadata: meta,
          }
        },
      }),

      ssh_read: tool({
        description: T.ssh_read[lang],
        args: {
          source: tool.schema.enum(["buffer", "history"]).optional().describe(T.ssh_read_args.source[lang]),
          lines: tool.schema.number().optional().describe(T.ssh_read_args.lines[lang]),
          direction: tool.schema.enum(["tail", "head"]).optional().describe(T.ssh_read_args.direction[lang]),
          limit: tool.schema.number().optional().describe(T.ssh_read_args.limit[lang]),
          includeCommand: tool.schema.boolean().optional().describe(T.ssh_read_args.includeCommand[lang]),
          name: tool.schema.string().optional().describe(T.ssh_read_args.name[lang]),
        },
        async execute(args, context) {
          const session = getSession(context.sessionID, args.name)
          if (!session) return tr("not_connected", lang)
          const source = args.source ?? "history"

          if (source === "buffer") {
            // 实时未消费缓冲
            const r = await session.readBuffer()
            const out = args.lines ? r.output.split(/\r?\n/).slice(0, args.lines).join("\n") : r.output
            return { title: tr("session_output_title", lang), output: out }
          }

          // history：已完成命令+输出对（前 N / 后 N）
          const history = session.getHistory()
          const all = history.getPairs()
          const limit = Math.max(1, args.limit ?? 10)
          const direction = args.direction ?? "tail"
          const selected = direction === "tail" ? all.slice(-limit) : all.slice(0, limit)
          const total = all.length
          const includeCommand = args.includeCommand ?? false

          const text = selected
            .map((p) => (includeCommand ? `$ ${p.command}\n${history.readOutput(p)}` : history.readOutput(p)))
            .join("\n")
          const browserLine = httpServer
            ? tr("browser_full_record", lang).replace("{url}", httpServer.url)
            : tr("server_not_enabled", lang)
          const titleKey = direction === "tail" ? "history_title" : "history_title_head"
          return {
            title: tr(titleKey, lang).replace("{n}", String(selected.length)).replace("{total}", String(total)),
            output: text + browserLine,
            metadata: {
              direction,
              returned: selected.length,
              total,
              sessionID: context.sessionID,
              host: session.getStatus().host,
            },
          }
        },
      }),

      ssh_status: tool({
        description: T.ssh_status[lang],
        args: {
          name: tool.schema.string().optional().describe(T.ssh_status_args.name[lang]),
        },
        async execute(args, context) {
          const map = getSessionMap(context.sessionID)
          if (!map || map.size === 0) return tr("no_sessions", lang)

          // 未指定 name → 列出全部终端状态
          const session = args.name ? map.get(args.name) : undefined
          if (args.name && !session) return tr("no_sessions", lang)
          const sessions = session ? [session] : [...map.values()]

          const parts: string[] = []
          for (const s of sessions) {
            const st: SessionStatus = s.getStatus()
            if (!st.connected) {
              parts.push(tr("session_disconnected", lang))
              continue
            }
            parts.push(
              [
                `name: ${st.name ?? "default"}`,
                `connected: ${st.connected}`,
                `busy: ${st.busy}`,
                `pending: ${st.pending} bytes`,
                `host: ${st.host}@${st.user}:${st.port}`,
                st.lastActive ? `lastActive: ${new Date(st.lastActive).toISOString()}` : null,
                st.connectedAt ? `connectedAt: ${new Date(st.connectedAt).toISOString()}` : null,
              ].filter(Boolean).join("\n")
            )
            parts.push(st.busy ? tr("status_busy_hint", lang) : tr("status_idle_hint", lang))
          }

          // 并入 HTTP 服务状态
          const serverLines = httpServer
            ? [
                "",
                `httpServer: ${httpServer.url}`,
                `httpPort: ${httpServer.port}`,
                `activeSessions: ${listSessionEntries().length}`,
              ]
            : ["", "httpServer: disabled"]

          return { title: tr("status_title", lang), output: parts.join("\n\n") + serverLines.join("\n") }
        },
      }),

      ssh_disconnect: tool({
        description: T.ssh_disconnect[lang],
        args: {
          name: tool.schema.string().optional().describe(T.ssh_disconnect_args.name[lang]),
        },
        async execute(args, context) {
          const { sessionID } = context
          const map = getSessionMap(sessionID)
          if (!map || map.size === 0) return tr("no_sessions", lang)

          // 未指定 name → 断开全部终端；否则断开指定终端
          if (!args.name) {
            const host = [...map.values()][0]?.getStatus().host
            cleanupAllSessions(sessionID)
            return tr("disconnected_all_ok", lang).replace("{host}", host ?? "-")
          }
          const session = map.get(args.name)
          if (!session) return tr("no_sessions", lang)
          const host = session.getStatus().host
          cleanupSession(sessionID, args.name)
          return tr("disconnected_ok", lang).replace("{host}", host ?? "-")
        },
      }),
    },
  }
}

// 默认导出：opencode 加载插件优先取 mod.default（V1 格式），具名导出不一定被识别
export default OpenCodeSshTool
