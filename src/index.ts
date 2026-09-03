// 插件入口：导出 5 个 SSH 工具 + 会话生命周期管理 + HTTP 终端记录服务

import { tool, type Plugin } from "@opencode-ai/plugin"
import stringArgv from "string-argv"
import { parseArgs } from "node:util"
import createLogger from "@xiaoqiong0v0/opencode-plugin-logger"
import { CACHE_DIR } from "./constants.js"
import { homedir } from "node:os"
import { join } from "node:path"
import { rmSync } from "node:fs"
import { loadConfig } from "./config.js"
import { SessionHistory } from "./history.js"
import { T, getLang, tr } from "./i18n.js"
import { createDecider } from "./permission.js"
import { SshSession } from "./session.js"
import { LocalSession } from "./local-session.js"
import { type ServerHandle, type SessionEntry } from "./server.js"
import { ensureServer } from "./server-manager.js"
import { writeSessionState, removeSessionState } from "./session-store.js"

const log = createLogger("opencode-ssh-tool")

/** 默认终端名（不传 name 时用） */
const DEFAULT_NAME = "default"

/** CLI 执行上下文（tool.execute 的 context 最小子集） */
type CliCtx = {
  sessionID: string
  ask: (input: { permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> }) => Promise<void>
}

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

/** 会话表：key = opencode sessionID → 内层 key = 终端名 → SshSession（内部状态，不导出） */
const sshSessions = new Map<string, Map<string, SshSession>>()

/** 本地/容器会话表：key = sessionID → 终端名 → LocalSession（Bun.Terminal，内部状态） */
const localSessions = new Map<string, Map<string, LocalSession>>()

/** 会话元信息（标题/目录，供 HTTP 页面显示），key = sessionID */
const sessionMeta = new Map<string, { title: string; directory: string }>()

/** HTTP 终端记录服务句柄（本进程持有，可能为 null） */
let httpServer: ServerHandle | null = null

/** HTTP 服务已知地址（本进程启动或复用时记录，供展示） */
let httpUrl = ""

/** 进程退出兜底：关闭全部连接（SSH + 本地终端）+ 关闭本进程持有的 HTTP 服务 */
process.on("exit", () => {
  for (const map of sshSessions.values()) for (const s of map.values()) s.close()
  for (const map of localSessions.values()) for (const s of map.values()) s.close()
  if (httpServer) {
    try {
      httpServer.close()
    } catch {
      /* 忽略 */
    }
  }
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

/**
 * 同步某终端状态到共享文件（跨进程聚合展示用，SSH 与本地/容器通用）
 * @param sessionID opencode 会话 ID
 * @param name 终端名（默认 default）
 */
function syncSessionState(sessionID: string, name = DEFAULT_NAME): void {
  const session = resolveSession(sessionID, name)
  if (!session) return
  const st = session.getStatus()
  const meta = sessionMeta.get(sessionID)
  const isLocal = !("host" in st) || !st.host
  writeSessionState(cacheRoot(), {
    sessionID,
    name,
    kind: isLocal ? "local" : "ssh",
    host: "host" in st ? st.host : undefined,
    user: "user" in st ? st.user : undefined,
    port: "port" in st ? st.port : undefined,
    program: "program" in st ? st.program : undefined,
    connected: st.connected,
    busy: st.busy,
    pending: st.pending,
    lastActive: st.lastActive,
    connectedAt: st.connectedAt,
    title: meta?.title,
    directory: meta?.directory,
    updatedAt: Date.now(),
  })
}

/** 按 sessionID 取本地/容器终端表（无则返回 undefined） */
function getLocalSessionMap(sessionID: string): Map<string, LocalSession> | undefined {
  return localSessions.get(sessionID)
}

/** 按 sessionID + 终端名取本地/容器会话（name 默认 default） */
function getLocalSession(sessionID: string, name = DEFAULT_NAME): LocalSession | undefined {
  return getLocalSessionMap(sessionID)?.get(name)
}

/** 解析终端会话：优先 SSH，其次本地/容器（合并后的操作工具统一用此查找） */
function resolveSession(sessionID: string, name = DEFAULT_NAME): SshSession | LocalSession | undefined {
  return getSession(sessionID, name) ?? getLocalSession(sessionID, name)
}

/** 清理指定本地终端：关闭 + 删状态文件 + 从会话表移除 */
function cleanupLocalSession(sessionID: string, name = DEFAULT_NAME): void {
  const map = getLocalSessionMap(sessionID)
  const session = map?.get(name)
  if (session) {
    session.close()
    map!.delete(name)
    if (map!.size === 0) localSessions.delete(sessionID)
  }
  removeSessionState(cacheRoot(), sessionID, name)
}

/** 清理一个 sessionID 下全部本地终端 */
function cleanupAllLocalSessions(sessionID: string): void {
  const map = getLocalSessionMap(sessionID)
  if (map) {
    for (const s of map.values()) s.close()
    for (const name of map.keys()) removeSessionState(cacheRoot(), sessionID, name)
    localSessions.delete(sessionID)
  }
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
  removeSessionState(cacheRoot(), sessionID, name)
}

/** 清理一个 sessionID 下全部终端 */
function cleanupAllSessions(sessionID: string): void {
  const map = getSessionMap(sessionID)
  if (map) {
    for (const s of map.values()) s.close()
    for (const name of map.keys()) removeSessionState(cacheRoot(), sessionID, name)
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
      const sr = await ensureServer(cfg.server.port, listSessionEntries, cacheRoot())
      if (sr.server) {
        httpServer = sr.server
        httpUrl = sr.url
        log.info(`HTTP 服务已启动 ${sr.url}`)
      } else if (sr.reused) {
        httpUrl = sr.url
        log.info(`HTTP 服务复用 ${sr.url}`)
      } else {
        log.info("HTTP 服务未启动（端口冲突或锁竞争）")
      }
    } catch (e) {
      log.error("HTTP 服务启动失败", e instanceof Error ? e : String(e))
    }
  } else {
    log.info("HTTP 服务未启用（配置 server.enabled=false）")
  }


  // ===== CLI 风格单工具（ssh_cli）子命令实现 =====

  /** 完整用法（模型自学手册） */
  const HELP_TEXT = tr("ssh_cli_help", lang)

  /** connect：SSH 连接（target=user@host[:port]） */
  async function doConnect(args: string[], ctx: CliCtx): Promise<string> {
    const { values, positionals } = parseArgs({ args, options: { name: { type: "string", short: "n" }, password: { type: "string", short: "p" }, user: { type: "string", short: "u" } }, allowPositionals: true })
    const target = positionals[0] ?? ""
    const m = target.match(/^(?:([^@]+)@)?([^:]+)(?::(\d+))?$/)
    if (!m || !m[2]) return `${tr("cli_bad_target", lang).replace("{target}", target)}\n${tr("cli_connect_usage", lang)}\n\n${HELP_TEXT}`
    const user = m[1] ?? values.user
    const host = m[2]
    const port = m[3] ? parseInt(m[3], 10) : undefined
    if (!user || !host) return `${tr("cli_need_user_host", lang)}\n${tr("cli_connect_usage", lang)}\n\n${HELP_TEXT}`
    const name = values.name ?? DEFAULT_NAME
    if (sanitizeName(name) === null) return tr("invalid_name", lang)
    try {
      await ctx.ask({
        permission: "ssh_connect",
        patterns: [`${user}@${host}:${port ?? 22}`],
        always: [`ssh_connect:${user}@${host}:${port ?? 22}`],
        metadata: { title: `${user}@${host}` },
      })
    } catch {
      return tr("rejected_connect", lang)
    }
    const map = getSessionMap(ctx.sessionID)
    const old = map?.get(name)
    if (old) {
      old.close()
      map!.delete(name)
    }
    const session = new SshSession(ctx.sessionID, new SessionHistory(join(cacheRoot(), ctx.sessionID), name, cfg.history.maxMessages), name)
    const result = await session.connect({ host, user, port, password: values.password })
    log.tool("ssh_connect", { host, user, port: port ?? 22, name })
    if (!result.ok) {
      session.close()
      return `${tr("connect_title_fail", lang)}: ${result.error ?? tr("unknown_error", lang)}`
    }
    if (!map) sshSessions.set(ctx.sessionID, new Map())
    sshSessions.get(ctx.sessionID)!.set(name, session)
    syncSessionState(ctx.sessionID, name)
    return tr("connect_ok", lang).replace("{user}", user).replace("{host}", host).replace("{port}", String(port ?? 22)).replace("{sid}", ctx.sessionID).replace("{name}", name)
  }

  /** local：本地/容器终端连接 */
  async function doLocal(args: string[], ctx: CliCtx): Promise<string> {
    const { values, positionals } = parseArgs({ args, options: { name: { type: "string", short: "n" }, cwd: { type: "string", short: "c" } }, allowPositionals: true })
    const command = positionals.join(" ")
    if (!command) return `${tr("cli_need_command", lang)}\n${tr("cli_local_usage", lang)}\n\n${HELP_TEXT}`
    const name = values.name ?? DEFAULT_NAME
    if (sanitizeName(name) === null) return tr("invalid_name", lang)
    const map = getLocalSessionMap(ctx.sessionID)
    const old = map?.get(name)
    if (old) {
      old.close()
      map!.delete(name)
    }
    const session = new LocalSession(ctx.sessionID, new SessionHistory(join(cacheRoot(), ctx.sessionID), `local-${name}`, cfg.history.maxMessages), name)
    const result = await session.connect({ command, cwd: values.cwd })
    log.tool("local_connect", { command, name })
    if (!result.ok) {
      session.close()
      return `${tr("local_connect_title_fail", lang)}: ${result.error ?? tr("unknown_error", lang)}`
    }
    if (!map) localSessions.set(ctx.sessionID, new Map())
    localSessions.get(ctx.sessionID)!.set(name, session)
    syncSessionState(ctx.sessionID, name)
    return tr("local_connect_ok", lang).replace("{cmd}", command).replace("{name}", name)
  }

  /** exec：在指定终端执行命令 */
  async function doExec(args: string[], ctx: CliCtx): Promise<string> {
    const { values, positionals } = parseArgs({ args, options: { name: { type: "string", short: "n" }, waitResult: { type: "boolean", short: "w" } }, allowPositionals: true })
    const command = positionals.join(" ")
    if (!command) return `${tr("cli_need_command", lang)}\n${tr("cli_exec_usage", lang)}\n\n${HELP_TEXT}`
    const session = resolveSession(ctx.sessionID, values.name)
    if (!session) return tr("not_connected", lang)
    const decision = decide(command)
    if (decision === "deny") {
      log.tool("term_exec_denied", { command })
      return tr("denied_danger", lang)
    }
    if (decision === "ask") {
      try {
        await ctx.ask({ permission: "term_exec", patterns: [command], always: [`term_exec:${command}`], metadata: { title: command.slice(0, 60) } })
      } catch {
        return tr("denied", lang)
      }
    }
    const result = values.waitResult ? await session.exec(command) : await session.submit(command)
    syncSessionState(ctx.sessionID, values.name ?? DEFAULT_NAME)
    log.tool("term_exec", { command, ok: result.ok, submitted: result.submitted, interactive: result.interactive, running: result.running })
    if (result.submitted) return tr("submitted", lang)
    return result.ok ? result.output : result.error ?? tr("exec_failed", lang)
  }

  /** read：读取终端输出 */
  async function doRead(args: string[], ctx: CliCtx): Promise<string> {
    const { values } = parseArgs({ args, options: { name: { type: "string", short: "n" }, source: { type: "string", short: "s" }, limit: { type: "string", short: "l" }, head: { type: "boolean" }, includeCommand: { type: "boolean" } }, allowPositionals: true })
    const session = resolveSession(ctx.sessionID, values.name)
    if (!session) return tr("not_connected", lang)
    const source = values.source ?? "history"
    if (source === "buffer") {
      const r = await session.readBuffer()
      return r.output
    }
    const history = session.getHistory()
    const all = history.getPairs()
    const limit = Math.max(1, parseInt(values.limit ?? "10", 10) || 10)
    const direction = values.head ? "head" : "tail"
    const selected = direction === "tail" ? all.slice(-limit) : all.slice(0, limit)
    const includeCommand = values.includeCommand ?? false
    const text = selected.map((p) => (includeCommand ? `$ ${p.command}\n${history.readOutput(p)}` : history.readOutput(p))).join("\n")
    const browserLine = httpUrl ? tr("browser_full_record", lang).replace("{url}", httpUrl) : tr("server_not_enabled", lang)
    return `${tr(direction === "tail" ? "history_title" : "history_title_head", lang).replace("{n}", String(selected.length)).replace("{total}", String(all.length))}\n${text}${browserLine}`
  }

  /** send：发送文本/按键到终端 */
  async function doSend(args: string[], ctx: CliCtx): Promise<string> {
    const { values, positionals } = parseArgs({ args, options: { name: { type: "string", short: "n" } }, allowPositionals: true })
    const text = positionals.join(" ")
    if (!text) return `${tr("cli_need_text", lang)}\n${tr("cli_send_usage", lang)}\n\n${HELP_TEXT}`
    const session = resolveSession(ctx.sessionID, values.name)
    if (!session) return tr("not_connected", lang)
    const r = session.send(text)
    if (!r.ok) return tr("err_not_connected", lang)
    syncSessionState(ctx.sessionID, values.name ?? DEFAULT_NAME)
    log.tool("term_send", { text: text.slice(0, 60), name: values.name ?? DEFAULT_NAME })
    return tr("send_ok", lang).replace("{text}", text.slice(0, 60))
  }

  /** status：终端状态 */
  async function doStatus(args: string[], ctx: CliCtx): Promise<string> {
    const { values } = parseArgs({ args, options: { name: { type: "string", short: "n" } }, allowPositionals: true })
    const smap = getSessionMap(ctx.sessionID)
    const lmap = getLocalSessionMap(ctx.sessionID)
    if ((!smap || smap.size === 0) && (!lmap || lmap.size === 0)) return tr("no_sessions", lang)
    let sessions: (SshSession | LocalSession)[]
    if (values.name) {
      const s = resolveSession(ctx.sessionID, values.name)
      if (!s) return tr("no_sessions", lang)
      sessions = [s]
    } else {
      sessions = [...(smap?.values() ?? []) as SshSession[], ...(lmap?.values() ?? []) as LocalSession[]]
    }
    const parts: string[] = []
    for (const s of sessions) {
      const st = s.getStatus()
      if (!st.connected) {
        parts.push(tr("session_disconnected", lang))
        continue
      }
      const connLine = "host" in st && st.host
        ? `${tr("st_host", lang)}: ${st.host}@${st.user}:${st.port}`
        : `${tr("st_program", lang)}: ${(st as { program?: string }).program ?? "-"}`
      parts.push([
        `${tr("st_name", lang)}: ${st.name ?? "default"}`,
        `${tr("st_type", lang)}: ${"host" in st ? "ssh" : "local"}`,
        `${tr("st_connected", lang)}: ${st.connected}`,
        `${tr("st_busy", lang)}: ${st.busy}`,
        `${tr("st_pending", lang)}: ${st.pending} ${tr("st_bytes", lang)}`,
        connLine,
        st.lastActive ? `${tr("st_last_active", lang)}: ${new Date(st.lastActive).toISOString()}` : null,
        st.connectedAt ? `${tr("st_connected_at", lang)}: ${new Date(st.connectedAt).toISOString()}` : null,
      ].filter(Boolean).join("\n"))
      parts.push(st.busy ? tr("status_busy_hint", lang) : tr("status_idle_hint", lang))
    }
    const serverLines = httpUrl
      ? ["", `${tr("st_http_server", lang)}: ${httpUrl}`, `${tr("st_active_sessions", lang)}: ${listSessionEntries().length}`]
      : ["", `${tr("st_http_server", lang)}: ${tr("st_disabled", lang)}`]
    return parts.join("\n\n") + serverLines.join("\n")
  }

  /** disconnect：断开终端 */
  async function doDisconnect(args: string[], ctx: CliCtx): Promise<string> {
    const { values } = parseArgs({ args, options: { name: { type: "string", short: "n" } }, allowPositionals: true })
    const smap = getSessionMap(ctx.sessionID)
    const lmap = getLocalSessionMap(ctx.sessionID)
    if ((!smap || smap.size === 0) && (!lmap || lmap.size === 0)) return tr("no_sessions", lang)
    if (!values.name) {
      const firstHost = [...(smap?.values() ?? [])][0]?.getStatus().host
      cleanupAllSessions(ctx.sessionID)
      cleanupAllLocalSessions(ctx.sessionID)
      return tr("disconnected_all_ok", lang).replace("{host}", firstHost ?? "-")
    }
    const ssh = getSession(ctx.sessionID, values.name)
    if (ssh) {
      const host = ssh.getStatus().host
      cleanupSession(ctx.sessionID, values.name)
      return tr("disconnected_ok", lang).replace("{host}", host ?? "-")
    }
    const local = getLocalSession(ctx.sessionID, values.name)
    if (local) {
      const program = local.getStatus().program
      cleanupLocalSession(ctx.sessionID, values.name)
      return tr("disconnected_ok", lang).replace("{host}", program ?? "-")
    }
    return tr("no_sessions", lang)
  }

  /** CLI 入口：解析命令行字符串并分发子命令 */
  async function handleCliCommand(raw: string, ctx: CliCtx): Promise<string> {
    const tokens = stringArgv(raw)
    const [cmd, ...rest] = tokens
    if (!cmd || cmd === "help") return HELP_TEXT
    switch (cmd) {
      case "connect": return doConnect(rest, ctx)
      case "local": return doLocal(rest, ctx)
      case "exec": return doExec(rest, ctx)
      case "read": return doRead(rest, ctx)
      case "send": return doSend(rest, ctx)
      case "status": return doStatus(rest, ctx)
      case "disconnect": return doDisconnect(rest, ctx)
      default: return `${tr("cli_unknown", lang).replace("{cmd}", cmd)}\n\n${HELP_TEXT}`
    }
  }

  return {
    event: async ({ event }) => {
      // 会话创建/更新时记录标题与目录（供 HTTP 页面显示会话名称）
      if (event.type === "session.created" || event.type === "session.updated") {
        const info = (event as { properties?: { info?: { id?: string; title?: string; directory?: string } } }).properties?.info
        if (info?.id) {
          sessionMeta.set(info.id, { title: info.title ?? "", directory: info.directory ?? "" })
          // 有活动终端时同步标题/目录到状态文件（供跨进程聚合）
          const map = getSessionMap(info.id)
          if (map) for (const name of map.keys()) syncSessionState(info.id, name)
        }
      }
      // 会话删除时清理：关闭全部终端连接 + 删缓存目录 + 删元信息
      if (event.type === "session.deleted") {
        const info = (event as { properties?: { info?: { id?: string } } }).properties?.info
        const sid = info?.id
        if (sid) {
          cleanupAllSessions(sid)
          cleanupAllLocalSessions(sid)
          sessionMeta.delete(sid)
          log.info(`会话 ${sid} 删除，已清理`)
        }
      }
    },
    tool: {
      ssh_cli: tool({
        description: T.ssh_cli[lang],
        args: {
          args: tool.schema.string().optional().describe(T.ssh_cli_args[lang]),
        },
        async execute(args, context) {
          return { title: "ssh_cli", output: await handleCliCommand(args.args ?? "help", context) }
        },
      }),
    },
  }
}

// 默认导出：opencode 加载插件优先取 mod.default（V1 格式），具名导出不一定被识别
export default OpenCodeSshTool