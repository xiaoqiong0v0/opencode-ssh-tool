// 插件入口：导出 5 个 SSH 工具 + 会话生命周期管理 + HTTP 终端记录服务

import { tool, type Plugin } from "@opencode-ai/plugin"
import { parseArgs } from "node:util"
import { randomUUID } from "node:crypto"
import log, { describeSend, infoDedupShared, sweepDedupDir } from "./log.js"
import { parseCliArgs } from "./cli-args.js"
import { PayloadError, normalizeExecText, resolvePayload, type ResolvedPayload } from "./payload.js"
import { CACHE_DIR, MAX_TRANSFER_BYTES, TRANSFER_PROGRESS_THROTTLE_MS, TRANSFER_TIMEOUT_MS } from "./constants.js"
import { homedir } from "node:os"
import { join } from "node:path"
import { rmSync } from "node:fs"
import { loadConfig } from "./config.js"
import { SessionHistory } from "./history.js"
import { T, getToolLang, getWebLang, tr, type FlatKey } from "./i18n.js"
import { toModelText } from "./utils.js"
import { createDecider } from "./permission.js"
import { runSshTransfer, SshSession } from "./session.js"
import { LocalSession } from "./local-session.js"
import { TransferError, parseTransferPositionals, type TransferErrorCode } from "./transfer.js"
import type { TransferTask } from "./transfer-events.js"
import { type SessionEntry } from "./server.js"
import { ensureServer, type ServerResult } from "./server-manager.js"
import { startAgent, type AgentHandle, type AgentSession } from "./agent.js"
import { writeSessionState, removeSessionState, removeAllSessionStates, writeSessionMeta } from "./session-store.js"
import { precheckBeforeExec } from "./precheck.js"

/** 默认终端名（不传 name 时用） */
const DEFAULT_NAME = "default"

/** CLI 执行上下文（tool.execute 的 context 最小子集） */
type CliCtx = {
  sessionID: string
  ask: (input: { permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> }) => Promise<void>
}

/** 终端名合法字符（字母/数字/下划线/中划线/点），防止路径穿越 */
const NAME_RE = /^[A-Za-z0-9_.-]+$/

/** 传输错误码 → i18n 文案键（展示文案不在 transfer.ts 中硬编码） */
const TRANSFER_ERROR_KEYS: Record<TransferErrorCode, FlatKey> = {
  exists: "transfer_err_exists",
  local_missing: "transfer_err_local_missing",
  local_is_dir: "transfer_err_local_is_dir",
  remote_missing: "transfer_err_remote_missing",
  remote_is_dir: "transfer_err_remote_is_dir",
  symlink: "transfer_err_symlink",
  parent_missing: "transfer_err_parent_missing",
  too_large: "transfer_err_too_large",
  sftp_unavailable: "transfer_err_sftp_unavailable",
  timeout: "transfer_err_timeout",
  io: "transfer_err_io",
  unsupported: "transfer_err_unsupported",
  ssh_only: "transfer_err_ssh_only",
  denied: "transfer_denied",
  tilde_user: "transfer_err_tilde_user",
  remote_path_backslash: "transfer_err_remote_path_backslash",
}

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

/**
 * 记录会话标题/目录并持久化到 meta.json（仅内容变化时写盘，避免 session.updated 每次刷盘）。
 * @param root 根会话 ID
 * @param title 标题
 * @param directory 工作目录
 * @returns 无
 */
function rememberSessionMeta(root: string, title: string, directory: string): void {
  const prev = sessionMeta.get(root)
  sessionMeta.set(root, { title, directory })
  if (!prev || prev.title !== title || prev.directory !== directory) {
    writeSessionMeta(cacheRoot(), root, { title, directory })
  }
}

/** HTTP 服务已知地址（独立进程托管，本进程仅记录用于展示） */
let httpUrl = ""

/** 代理客户端句柄（连接独立服务转发交互），可能为 null */
let agent: AgentHandle | null = null

/** 本进程持有的全部会话（供代理注册，{sessionID, name}[]） */
function listAgentSessions(): Array<{ sessionID: string; name: string }> {
  const out: Array<{ sessionID: string; name: string }> = []
  for (const [sessionID, map] of sshSessions) for (const name of map.keys()) out.push({ sessionID, name })
  for (const [sessionID, map] of localSessions) for (const name of map.keys()) out.push({ sessionID, name })
  return out
}

/** 按 sessionID/name 取会话（供代理转发执行），转为 AgentSession 结构 */
function resolveAgentSession(sessionID: string, name: string): AgentSession | undefined {
  return resolveSession(sessionID, name) as AgentSession | undefined
}

/** 会话增删后通知代理重新注册（无代理时空操作） */
function refreshAgent(): void {
  agent?.reRegister()
}

/** 进程退出兜底：关闭全部连接（SSH + 本地终端）+ 断开代理（独立服务不受影响） */
process.on("exit", () => {
  for (const map of sshSessions.values()) for (const s of map.values()) s.close()
  for (const map of localSessions.values()) for (const s of map.values()) s.close()
  agent?.close()
})

/** 按 sessionID 取内层终端表（无则返回 undefined） */
function getSessionMap(sessionID: string): Map<string, SshSession> | undefined {
  return sshSessions.get(sessionID)
}

/** 按 sessionID + 终端名取会话（name 默认 default） */
function getSession(sessionID: string, name = DEFAULT_NAME): SshSession | undefined {
  return getSessionMap(sessionID)?.get(name)
}

/** 扁平化会话条目列表（供 HTTP 服务展示，SSH + 本地/容器，kind 区分历史目录与展示） */
function listSessionEntries(): SessionEntry[] {
  const entries: SessionEntry[] = []
  for (const [sessionID, map] of sshSessions) {
    const meta = sessionMeta.get(sessionID)
    for (const [name, session] of map) entries.push({ sessionID, name, session, kind: "ssh", title: meta?.title, directory: meta?.directory })
  }
  for (const [sessionID, map] of localSessions) {
    const meta = sessionMeta.get(sessionID)
    for (const [name, session] of map) entries.push({ sessionID, name, session, kind: "local", title: meta?.title, directory: meta?.directory })
  }
  return entries
}

/**
 * 同步某终端状态到共享文件（跨进程聚合展示用，SSH 与本地/容器通用）
 * @param sessionID opencode 会话 ID
 * @param name 终端名（默认 default）
 * @param reason 写入原因（connect / exec前 / exec后 / send / session-meta 等，用于日志追溯）
 */
function syncSessionState(sessionID: string, name = DEFAULT_NAME, reason = "sync"): void {
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
  }, reason)
}

/**
 * 为终端挂接 busy 翻转监听：命令运行期间把 busy=true 写入状态文件，结束写回 false，
 * 使状态文件里的 busy 不停留在命令执行前落盘的过期值（server 拿不到 agent 状态、
 * 回退读状态文件时读到的是实时值）。复用既有 syncSessionState → writeSessionState，不新增写盘路径。
 * @param session 已注册的终端会话（SshSession / LocalSession）
 * @param sessionID opencode 会话 ID
 * @param name 终端名
 */
function hookBusyState(session: SshSession | LocalSession, sessionID: string, name: string): void {
  session.setBusyListener((_busy, reason) => syncSessionState(sessionID, name, `busy:${reason}`))
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
  refreshAgent()
}

/** 清理一个 sessionID 下全部本地终端 */
function cleanupAllLocalSessions(sessionID: string): void {
  const map = getLocalSessionMap(sessionID)
  if (map) {
    for (const s of map.values()) s.close()
    localSessions.delete(sessionID)
  }
  // 无论内存是否有句柄都清残留：状态文件 + 历史目录（含其他进程建的会话）
  removeAllSessionStates(cacheRoot(), sessionID)
  try {
    rmSync(join(cacheRoot(), sessionID), { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
  refreshAgent()
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
  refreshAgent()
}

/** 清理一个 sessionID 下全部终端 */
function cleanupAllSessions(sessionID: string): void {
  const map = getSessionMap(sessionID)
  if (map) {
    for (const s of map.values()) s.close()
    sshSessions.delete(sessionID)
  }
  // 无论内存是否有句柄都清残留：状态文件 + 历史目录（含其他进程建的会话）
  removeAllSessionStates(cacheRoot(), sessionID)
  try {
    rmSync(join(cacheRoot(), sessionID), { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
  refreshAgent()
}

// 发送前语法预检已抽到 ./precheck.ts，供 term_exec 与 web run-exec 共用。

export const OpenCodeSshTool: Plugin = async () => {
  // 父子会话关系（sessionID → parentID；根的 parentID 为 undefined）
  // 通过 session.created/updated 事件构建，用于根系查找（主子会话共享终端）
  const childMap = new Map<string, string | undefined>()

  /**
   * 沿 parentID 链找到根会话 ID（主子会话共享存储key）
   * 输出异常时回退回原 sessionID
   */
  const findRoot = (sessionID: string): string => {
    let cur = sessionID
    const visited = new Set<string>()
    while (cur && !visited.has(cur)) {
      visited.add(cur)
      const parent = childMap.get(cur)
      if (parent !== undefined && parent !== null) { cur = parent; continue }
      break
    }
    return cur
  }
  // 插件实例批量加载（评测一次起多个 opencode run）时，"loaded" 每实例刷一条无信息量，
  // 用跨进程短窗去重合并（同一时间窗内多次加载只记一条，下次窗口外补"重复 N 次"）
  sweepDedupDir() // 顺手清理 7 天前的跨进程去重标记（只存 {ts,count}，删除安全）
  infoDedupShared("plugin-loaded", "loaded", 10000)

  // 加载配置并"发起"HTTP 终端记录服务启动（默认开启；端口 0=自动分配）。
  // 刻意不 await：服务启动慢/失败均不阻塞插件加载与命令执行；需要 URL 的路径再惰性等待下面的 Promise。
  const cfg = loadConfig()
  // 语言：toolLang 用于工具描述/CLI/session 文案（SSH_TOOL_LANG 覆盖）；webLang 仅用于 Web 页面 UI（SSH_WEB_LANG 覆盖）
  const toolLang = getToolLang(cfg.toolLang)
  const webLang = getWebLang(cfg.webLang)
  // 权限判定器：内置正则 + 配置自定义 deny/allow 正则
  const decide = createDecider(cfg.permission.deny, cfg.permission.allow)
  // 中断探针补发间隔：配置为秒（默认 5，已在 config 校验 >0），会话构造时转毫秒（下限 1ms）
  const interruptProbeIntervalMs = Math.max(1, Math.round(cfg.interruptProbeInterval * 1000))
  // 服务启动 Promise（null=配置未启用）；失败已在 server-manager 内收敛为失败结果，这里再兜底 catch 避免 unhandled rejection
  let serverStart: Promise<ServerResult> | null = null
  if (cfg.server.enabled) {
    serverStart = ensureServer(cfg.server.port, listSessionEntries, cacheRoot(), webLang)
      .then((sr) => {
        if (sr.url) {
          httpUrl = sr.url
          // 多实例共享同一服务，"复用"行按 url 跨进程去重（首次"已启动"仍即时可见）
          infoDedupShared(`http-service:${sr.url}`, `HTTP 服务${sr.reused ? "复用" : "已启动"} ${sr.url}`, 10000)
          const wsUrl = sr.url.replace(/^http/, "ws") + "/ws"
          agent = startAgent(wsUrl, resolveAgentSession, listAgentSessions)
        } else {
          log.info("HTTP 服务未启动（固定端口绑定被拒或端口/锁竞争），Web 记录不可用；命令执行不受影响")
        }
        return sr
      })
      .catch((e) => {
        log.error("HTTP 服务启动失败", e instanceof Error ? e : String(e))
        return { server: null, url: "", port: 0, reused: false } satisfies ServerResult
      })
  } else {
    log.info("HTTP 服务未启用（配置 server.enabled=false）")
  }

  /**
   * 惰性获取 Web 记录服务地址：等待启动 Promise 但失败不抛错（命令执行不受影响）
   * @returns 服务 URL；未启用或不可用时为空串
   */
  async function resolveHttpUrl(): Promise<string> {
    if (!serverStart) return ""
    try {
      await serverStart
    } catch {
      /* 启动异常已在工厂内记录 */
    }
    return httpUrl
  }

  /**
   * Web 服务不可用时的提示文案键：配置关闭 → 未启用；已发起但未起来 → 未启动（命令执行不受影响）
   * @returns i18n 文案键
   */
  function httpUnavailableKey(): FlatKey {
    return serverStart ? "server_unavailable" : "server_not_enabled"
  }


  // ===== CLI 风格单工具（term_cli）子命令实现 =====

  /** 完整用法（模型自学手册） */
  const HELP_TEXT = tr("term_cli_help", toolLang)

  /** connect：SSH 连接（target=user@host[:port]） */
  async function doConnect(args: string[], ctx: CliCtx): Promise<string> {
    const { values, positionals } = parseArgs({ args, options: { name: { type: "string", short: "n" }, password: { type: "string", short: "p" }, user: { type: "string", short: "u" } }, allowPositionals: true })
    const target = positionals[0] ?? ""
    const m = target.match(/^(?:([^@]+)@)?([^:]+)(?::(\d+))?$/)
    if (!m || !m[2]) return `${tr("cli_bad_target", toolLang).replace("{target}", target)}\n${tr("cli_connect_usage", toolLang)}\n\n${HELP_TEXT}`
    const user = m[1] ?? values.user
    const host = m[2]
    const port = m[3] ? parseInt(m[3], 10) : undefined
    if (!user || !host) return `${tr("cli_need_user_host", toolLang)}\n${tr("cli_connect_usage", toolLang)}\n\n${HELP_TEXT}`
    const name = values.name ?? DEFAULT_NAME
    if (sanitizeName(name) === null) return tr("invalid_name", toolLang)
    try {
      await ctx.ask({
        permission: "ssh_connect",
        patterns: [`${user}@${host}:${port ?? 22}`],
        always: [`ssh_connect:${user}@${host}:${port ?? 22}`],
        metadata: { title: `${user}@${host}` },
      })
    } catch {
      return tr("rejected_connect", toolLang)
    }
    // 先占住会话表再 await 连接：两个不同名终端并行 connect 时，
    // 不能各自在 await 后 new Map() 覆盖对方（会丢终端并触发状态文件孤儿清理）。
    let map = getSessionMap(ctx.sessionID)
    if (!map) {
      map = new Map()
      sshSessions.set(ctx.sessionID, map)
    }
    const old = map.get(name)
    if (old) {
      old.close()
      map.delete(name)
    }
    const session = new SshSession(ctx.sessionID, new SessionHistory(join(cacheRoot(), ctx.sessionID), name, cfg.history.maxMessages), name, toolLang, interruptProbeIntervalMs)
    const result = await session.connect({ host, user, port, password: values.password })
    log.tool("ssh_connect", { sessionID: ctx.sessionID, name, host, user, port: port ?? 22 })
    if (!result.ok) {
      session.close()
      return `${tr("connect_title_fail", toolLang)}: ${result.error ?? tr("unknown_error", toolLang)}`
    }
    map.set(name, session)
    hookBusyState(session, ctx.sessionID, name)
    syncSessionState(ctx.sessionID, name, "connect")
    refreshAgent()
    return tr("connect_ok", toolLang).replace("{user}", user).replace("{host}", host).replace("{port}", String(port ?? 22)).replace("{sid}", ctx.sessionID).replace("{name}", name)
  }

  /** local：本地/容器终端连接 */
  async function doLocal(args: string[], ctx: CliCtx): Promise<string> {
    const { values, positionals } = parseArgs({ args, options: { name: { type: "string", short: "n" }, cwd: { type: "string", short: "c" } }, allowPositionals: true })
    const command = positionals.join(" ")
    if (!command) return `${tr("cli_need_command", toolLang)}\n${tr("cli_local_usage", toolLang)}\n\n${HELP_TEXT}`
    const name = values.name ?? DEFAULT_NAME
    if (sanitizeName(name) === null) return tr("invalid_name", toolLang)
    // 同样先占住会话表，避免并行 local 连接互相覆盖。
    let map = getLocalSessionMap(ctx.sessionID)
    if (!map) {
      map = new Map()
      localSessions.set(ctx.sessionID, map)
    }
    const old = map.get(name)
    if (old) {
      old.close()
      map.delete(name)
    }
    const session = new LocalSession(ctx.sessionID, new SessionHistory(join(cacheRoot(), ctx.sessionID), `local-${name}`, cfg.history.maxMessages), name, toolLang, interruptProbeIntervalMs)
    const result = await session.connect({ command, cwd: values.cwd })
    log.tool("local_connect", { sessionID: ctx.sessionID, name, command })
    if (!result.ok) {
      session.close()
      return `${tr("local_connect_title_fail", toolLang)}: ${result.error ?? tr("unknown_error", toolLang)}`
    }
    map.set(name, session)
    hookBusyState(session, ctx.sessionID, name)
    syncSessionState(ctx.sessionID, name, "local")
    refreshAgent()
    return tr("local_connect_ok", toolLang).replace("{cmd}", command).replace("{name}", name)
  }

  /**
   * 载荷解析错误 → 本地化文案
   * @param err 载荷解析错误
   * @param file 用户传入的 --file 值（文件错误文案里回显原路径）
   * @returns 本地化错误文案
   */
  function payloadErrorText(err: PayloadError, file?: string): string {
    if (err.code === "conflict") return tr("payload_conflict", toolLang)
    if (err.code === "base64") return tr("payload_bad_base64", toolLang)
    if (err.code === "decode") return tr("payload_bad_encoding", toolLang)
    return tr("payload_file_error", toolLang).replace("{path}", file ?? "")
  }

  /** exec：在指定终端执行命令 */
  async function doExec(args: string[], ctx: CliCtx): Promise<string> {
    const { values, positionals } = parseArgs({ args, options: { name: { type: "string", short: "n" }, waitResult: { type: "boolean", short: "w" }, base64: { type: "boolean" }, file: { type: "string" } }, allowPositionals: true })
    let payload: ResolvedPayload
    try {
      payload = await resolvePayload(positionals.join(" "), { base64: values.base64, file: values.file })
    } catch (e) {
      if (e instanceof PayloadError) {
        log.tool("payload_error", { code: e.code, message: e.message })
        return payloadErrorText(e, values.file)
      }
      throw e
    }
    // text 模式维持原样（由 exec 管线自行处理）；base64/file 只归一 CRLF，避免双提交/空行
    const command = payload.source === "text" ? payload.text : normalizeExecText(payload.text)
    if (!command) return `${tr("cli_need_command", toolLang)}\n${tr("cli_exec_usage", toolLang)}\n\n${HELP_TEXT}`
    const session = resolveSession(ctx.sessionID, values.name)
    if (!session) return tr("not_connected", toolLang)
    // 发送前语法预检：本地走 parse-check，SSH 远程走独立 exec channel；命中语法错误即拦下
    // （不写终端、不进权限询问）；不支持的 shell / 通道异常 / 超时 → 内部一律放行（fail-open）
    const rejection = await precheckBeforeExec(session, command, undefined, toolLang)
    if (rejection) {
      log.tool("term_exec_precheck_rejected", {
        sessionID: ctx.sessionID,
        name: values.name ?? DEFAULT_NAME,
        ...(payload.source === "text" ? { command } : { source: payload.source, length: command.length }),
        shell: session.shellName,
      })
      return rejection
    }
    const decision = decide(command)
    if (decision === "deny") {
      log.tool("term_exec_denied", {
        sessionID: ctx.sessionID,
        name: values.name ?? DEFAULT_NAME,
        ...(payload.source === "text" ? { command } : { source: payload.source, length: command.length }),
      })
      return tr("denied_danger", toolLang)
    }
    if (decision === "ask") {
      try {
        await ctx.ask({ permission: "term_exec", patterns: [command], always: [`term_exec:${command}`], metadata: { title: command.slice(0, 60) } })
      } catch {
        return tr("denied", toolLang)
      }
    }
    const name = values.name ?? DEFAULT_NAME
    syncSessionState(ctx.sessionID, name, "exec前")
    const result = values.waitResult ? await session.exec(command) : await session.submit(command)
    syncSessionState(ctx.sessionID, name, "exec后")
    log.tool("term_exec", {
      sessionID: ctx.sessionID,
      name,
      ...(payload.source === "text" ? { command } : { source: payload.source, length: command.length }),
      ok: result.ok,
      submitted: result.submitted,
      running: result.running,
    })
    if (result.submitted) return tr("submitted", toolLang)
    return result.ok ? result.output : result.error ?? tr("exec_failed", toolLang)
  }

  /** read：读取终端输出 */
  async function doRead(args: string[], ctx: CliCtx): Promise<string> {
    const { values } = parseArgs({ args, options: { name: { type: "string", short: "n" }, source: { type: "string", short: "s" }, limit: { type: "string", short: "l" }, head: { type: "boolean" }, includeCommand: { type: "boolean" } }, allowPositionals: true })
    const session = resolveSession(ctx.sessionID, values.name)
    if (!session) return tr("not_connected", toolLang)
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
    // 逐条顺序处理（toModelText 内部 headless write 为异步，不能放在同步 map 中）
    const parts: string[] = []
    for (const p of selected) parts.push((includeCommand ? `$ ${p.command}\n` : "") + await toModelText(history.readOutput(p)))
    const text = parts.join("\n")
    const url = await resolveHttpUrl()
    const browserLine = url ? tr("browser_full_record", toolLang).replace("{url}", url) : tr(httpUnavailableKey(), toolLang)
    return `${tr(direction === "tail" ? "history_title" : "history_title_head", toolLang).replace("{n}", String(selected.length)).replace("{total}", String(all.length))}\n${text}${browserLine}`
  }

  /** send：发送文本/按键到终端 */
  async function doSend(args: string[], ctx: CliCtx): Promise<string> {
    const { values, positionals } = parseArgs({ args, options: { name: { type: "string", short: "n" }, base64: { type: "boolean" }, file: { type: "string" } }, allowPositionals: true })
    let payload: ResolvedPayload
    try {
      payload = await resolvePayload(positionals.join(" "), { base64: values.base64, file: values.file })
    } catch (e) {
      if (e instanceof PayloadError) {
        log.tool("payload_error", { code: e.code, message: e.message })
        return payloadErrorText(e, values.file)
      }
      throw e
    }
    const text = payload.text
    if (!text) return `${tr("cli_need_text", toolLang)}\n${tr("cli_send_usage", toolLang)}\n\n${HELP_TEXT}`
    const session = resolveSession(ctx.sessionID, values.name)
    if (!session) return tr("not_connected", toolLang)
    const r = session.send(text, { raw: payload.raw })
    if (!r.ok) return tr("err_not_connected", toolLang)
    syncSessionState(ctx.sessionID, values.name ?? DEFAULT_NAME, "send")
    // 只记来源/长度与类型，绝不打印载荷内容（base64/file 尤其可能含密码/密钥）
    const logFields = payload.source === "text"
      ? { send: describeSend(text), source: payload.source }
      : { source: payload.source, length: text.length }
    log.tool("term_send", { sessionID: ctx.sessionID, name: values.name ?? DEFAULT_NAME, ...logFields })
    if (payload.source === "text") return tr("send_ok", toolLang).replace("{text}", text.slice(0, 60))
    return tr("send_ok_source", toolLang).replace("{source}", payload.source).replace("{length}", String(text.length))
  }

  /**
   * 传输错误 → 本地化可操作文案（路径/上限/超时秒数由常量填充，不硬编码）
   * @param err 传输错误
   * @returns 本地化文案
   */
  function transferErrorText(err: TransferError): string {
    const template = tr(TRANSFER_ERROR_KEYS[err.code], toolLang)
    const limitMiB = Math.round(MAX_TRANSFER_BYTES / (1024 * 1024))
    return template
      .replace("{path}", err.path ?? "-")
      .replace("{reason}", err.detail ?? "")
      .replace("{limit}", `${limitMiB} MiB`)
      .replace("{seconds}", String(Math.round(TRANSFER_TIMEOUT_MS / 1000)))
  }

  /**
   * upload / download 共用实现：解析参数 → 仅 SSH 会话 → 权限审批 → SFTP 传输 → 回执
   * 传输内容不进入工具输出/日志；日志只记方向、路径、字节、耗时、ok、错误码。
   * @param direction 传输方向
   * @param args 子命令参数
   * @param ctx 执行上下文
   * @returns 回执或错误文案
   */
  async function doTransfer(direction: "upload" | "download", args: string[], ctx: CliCtx): Promise<string> {
    const usage = tr(direction === "upload" ? "cli_upload_usage" : "cli_download_usage", toolLang)
    const { values, positionals } = parseArgs({ args, options: { name: { type: "string", short: "n" }, overwrite: { type: "boolean" }, mkdir: { type: "boolean" } }, allowPositionals: true })
    const pair = parseTransferPositionals(positionals)
    if (!pair) return `${tr("cli_need_transfer_paths", toolLang)}\n${usage}\n\n${HELP_TEXT}`
    const { first, second } = pair
    const name = values.name ?? DEFAULT_NAME
    if (sanitizeName(name) === null) return tr("invalid_name", toolLang)
    const session = resolveSession(ctx.sessionID, name)
    if (!session) return tr("not_connected", toolLang)

    const permission = direction === "upload" ? "file_upload" : "file_download"
    const overwrite = values.overwrite === true
    const mkdir = values.mkdir === true
    const logKey = direction === "upload" ? "file_upload" : "file_download"
    /** 当前传输任务（审批通过、run 开始时创建；拒绝/非 SSH 不创建，因此不会被伪造上报） */
    let transferTask: TransferTask | null = null
    /** 最近一次进度回调值（字节/总数），完成或失败时用于补齐最终值 */
    let lastBytes = 0
    let lastTotal = 0
    /** 进度节流的尾沿定时器（窗口内多次回调合并为最新一帧） */
    let progressTimer: ReturnType<typeof setTimeout> | null = null
    /** 上次实际发出进度事件的时刻（毫秒） */
    let lastEmitAt = 0

    /** 发送传输任务元数据（无 agent/未连接时静默丢弃；只发元数据，不含内容） */
    const emitTransfer = (task: TransferTask): void => { agent?.transfer(task) }

    /** 清除待发的进度尾沿定时器 */
    const clearProgressTimer = (): void => {
      if (progressTimer) { clearTimeout(progressTimer); progressTimer = null }
    }

    /** 立即发送当前进度（以最新回调值为准） */
    const flushProgress = (): void => {
      progressTimer = null
      if (!transferTask || transferTask.state !== "running") return
      lastEmitAt = Date.now()
      emitTransfer({ ...transferTask, bytes: lastBytes, total: lastTotal })
    }

    /**
     * 进度回调（由 transfer.ts 在每块数据后调用）：按 TRANSFER_PROGRESS_THROTTLE_MS 节流；
     * 首次超过窗口立即发，否则挂一个尾沿定时器，保证窗口内最新值最终被发出。
     * @param bytes 已传字节数
     * @param total 总字节数
     */
    const onProgress = (bytes: number, total: number): void => {
      lastBytes = bytes
      lastTotal = total
      if (!transferTask || transferTask.state !== "running") return
      const elapsed = Date.now() - lastEmitAt
      if (elapsed >= TRANSFER_PROGRESS_THROTTLE_MS) { flushProgress(); return }
      if (progressTimer === null) {
        progressTimer = setTimeout(flushProgress, TRANSFER_PROGRESS_THROTTLE_MS - elapsed)
        if (typeof progressTimer.unref === "function") progressTimer.unref()
      }
    }

    /** 取当前未结束的任务（跨异步回调读取，避免 TS 把闭包内赋值的变量误窄化为 null） */
    const runningTask = (): TransferTask | null =>
      transferTask && transferTask.state === "running" ? transferTask : null

    try {
      // runSshTransfer 固定顺序：instanceof SshSession → ctx.ask → 实际传输
      const result = await runSshTransfer({
        session,
        ask: () => ctx.ask({
          permission,
          patterns: [first, second],
          // overwrite/mkdir 参与 always 键：避免"总是允许"普通上传后，同路径 --overwrite 不再询问
          always: [`${permission}:${first}:${second}:ow=${overwrite ? 1 : 0}:mkdir=${mkdir ? 1 : 0}`],
          metadata: { title: `${first} -> ${second}`, overwrite, mkdir },
        }),
        run: async (ssh) => {
          // 审批通过、真正开始传输时才建任务并上报 running（拒绝/非 SSH 不会走到这里）
          const startedAt = Date.now()
          transferTask = {
            id: randomUUID(),
            sessionID: ctx.sessionID,
            name,
            direction,
            localPath: direction === "upload" ? first : second,
            remotePath: direction === "upload" ? second : first,
            state: "running",
            bytes: 0,
            total: 0,
            startedAt,
          }
          lastBytes = 0
          lastTotal = 0
          lastEmitAt = startedAt
          emitTransfer({ ...transferTask })
          return direction === "upload"
            ? ssh.uploadFile({ localPath: first, remotePath: second, overwrite, mkdir, onProgress })
            : ssh.downloadFile({ remotePath: first, localPath: second, overwrite, mkdir, onProgress })
        },
      })
      const activeTask = runningTask()
      if (activeTask) {
        clearProgressTimer()
        // 完成补最终值：路径/字节取实际结果；total 优先用进度回调拿到的 stat 大小
        const finished: TransferTask = {
          ...activeTask,
          localPath: result.localPath,
          remotePath: result.remotePath,
          state: "done",
          bytes: result.bytes,
          total: lastTotal || result.bytes,
          endedAt: Date.now(),
        }
        transferTask = finished
        emitTransfer(finished)
      }
      log.tool(logKey, {
        sessionID: ctx.sessionID,
        name,
        local: result.localPath,
        remote: result.remotePath,
        bytes: result.bytes,
        duration: result.duration,
        ok: true,
      })
      return tr(direction === "upload" ? "upload_ok" : "download_ok", toolLang)
        .replace("{local}", result.localPath)
        .replace("{remote}", result.remotePath)
        .replace("{bytes}", String(result.bytes))
        .replace("{ms}", String(result.duration))
    } catch (e) {
      const err = e instanceof TransferError ? e : new TransferError("io", undefined, e instanceof Error ? e.message : String(e))
      const activeTask = runningTask()
      if (activeTask) {
        clearProgressTimer()
        const failed: TransferTask = {
          ...activeTask,
          state: "failed",
          bytes: lastBytes,
          total: lastTotal,
          endedAt: Date.now(),
          errorCode: err.code,
        }
        transferTask = failed
        emitTransfer(failed)
      } else {
        clearProgressTimer()
      }
      // 失败详情（含回滚失败时的 .bak 路径）同时进日志，便于事后定位
      log.tool(logKey, {
        sessionID: ctx.sessionID,
        name,
        local: first,
        remote: second,
        ok: false,
        code: err.code,
        ...(err.detail ? { reason: err.detail } : {}),
      })
      return transferErrorText(err)
    }
  }

  /** upload：本机文件 → SSH 远端（SFTP） */
  function doUpload(args: string[], ctx: CliCtx): Promise<string> {
    return doTransfer("upload", args, ctx)
  }

  /** download：SSH 远端 → 本机（SFTP） */
  function doDownload(args: string[], ctx: CliCtx): Promise<string> {
    return doTransfer("download", args, ctx)
  }

  /** status：终端状态 */
  async function doStatus(args: string[], ctx: CliCtx): Promise<string> {
    const { values } = parseArgs({ args, options: { name: { type: "string", short: "n" } }, allowPositionals: true })
    const smap = getSessionMap(ctx.sessionID)
    const lmap = getLocalSessionMap(ctx.sessionID)
    if ((!smap || smap.size === 0) && (!lmap || lmap.size === 0)) return tr("no_sessions", toolLang)
    let sessions: (SshSession | LocalSession)[]
    if (values.name) {
      const s = resolveSession(ctx.sessionID, values.name)
      if (!s) return tr("no_sessions", toolLang)
      sessions = [s]
    } else {
      sessions = [...(smap?.values() ?? []) as SshSession[], ...(lmap?.values() ?? []) as LocalSession[]]
    }
    const parts: string[] = []
    for (const s of sessions) {
      const st = s.getStatus()
      if (!st.connected) {
        parts.push(tr("session_disconnected", toolLang))
        continue
      }
      const connLine = "host" in st && st.host
        ? `${tr("st_host", toolLang)}: ${st.host}@${st.user}:${st.port}`
        : `${tr("st_program", toolLang)}: ${(st as { program?: string }).program ?? "-"}`
      parts.push([
        `${tr("st_name", toolLang)}: ${st.name ?? "default"}`,
        `${tr("st_type", toolLang)}: ${"host" in st ? "ssh" : "local"}`,
        `${tr("st_connected", toolLang)}: ${st.connected}`,
        `${tr("st_busy", toolLang)}: ${st.busy}`,
        `${tr("st_pending", toolLang)}: ${st.pending} ${tr("st_bytes", toolLang)}`,
        connLine,
        st.lastActive ? `${tr("st_last_active", toolLang)}: ${new Date(st.lastActive).toISOString()}` : null,
        st.connectedAt ? `${tr("st_connected_at", toolLang)}: ${new Date(st.connectedAt).toISOString()}` : null,
      ].filter(Boolean).join("\n"))
      parts.push(st.busy ? tr("status_busy_hint", toolLang) : tr("status_idle_hint", toolLang))
    }
    const serverUrl = await resolveHttpUrl()
    const serverLines = serverUrl
      ? ["", `${tr("st_http_server", toolLang)}: ${serverUrl}`, `${tr("st_active_sessions", toolLang)}: ${listSessionEntries().length}`]
      : ["", `${tr("st_http_server", toolLang)}: ${tr(serverStart ? "st_server_unavailable" : "st_disabled", toolLang)}`]
    return parts.join("\n\n") + serverLines.join("\n")
  }

  /** disconnect：断开终端 */
  async function doDisconnect(args: string[], ctx: CliCtx): Promise<string> {
    const { values } = parseArgs({ args, options: { name: { type: "string", short: "n" } }, allowPositionals: true })
    const smap = getSessionMap(ctx.sessionID)
    const lmap = getLocalSessionMap(ctx.sessionID)
    if ((!smap || smap.size === 0) && (!lmap || lmap.size === 0)) return tr("no_sessions", toolLang)
    if (!values.name) {
      const firstSshHost = [...(smap?.values() ?? [])][0]?.getStatus().host
      const firstLocalProgram = [...(lmap?.values() ?? [])][0]?.getStatus().program
      cleanupAllSessions(ctx.sessionID)
      cleanupAllLocalSessions(ctx.sessionID)
      if (firstSshHost) return tr("disconnected_all_ok", toolLang).replace("{host}", firstSshHost)
      return tr("disconnected_all_ok_local", toolLang).replace("{program}", firstLocalProgram ?? "-")
    }
    const ssh = getSession(ctx.sessionID, values.name)
    if (ssh) {
      const host = ssh.getStatus().host
      cleanupSession(ctx.sessionID, values.name)
      return tr("disconnected_ok", toolLang).replace("{host}", host ?? "-")
    }
    const local = getLocalSession(ctx.sessionID, values.name)
    if (local) {
      const program = local.getStatus().program
      cleanupLocalSession(ctx.sessionID, values.name)
      return tr("disconnected_ok_local", toolLang).replace("{program}", program ?? "-")
    }
    return tr("no_sessions", toolLang)
  }

  /** CLI 入口：解析命令行字符串并分发子命令 */
  async function handleCliCommand(raw: string, ctx: CliCtx): Promise<string> {
    const parsed = parseCliArgs(raw)
    if (parsed.unclosedQuote) return `${tr("cli_unclosed_quote", toolLang)}\n\n${HELP_TEXT}`
    const [cmd, ...rest] = parsed.tokens
    if (!cmd || cmd === "help") return HELP_TEXT
    // 统一按根会话 ID 路由（主子会话共享终端）
    const rootID = await findRoot(ctx.sessionID)
    const rootCtx: CliCtx = { ...ctx, sessionID: rootID }
    switch (cmd) {
      case "connect": return doConnect(rest, rootCtx)
      case "local": return doLocal(rest, rootCtx)
      case "exec": return doExec(rest, rootCtx)
      case "read": return doRead(rest, rootCtx)
      case "send": return doSend(rest, rootCtx)
      case "upload": return doUpload(rest, rootCtx)
      case "download": return doDownload(rest, rootCtx)
      case "status": return doStatus(rest, rootCtx)
      case "disconnect": return doDisconnect(rest, rootCtx)
      default: return `${tr("cli_unknown", toolLang).replace("{cmd}", cmd)}\n\n${HELP_TEXT}`
    }
  }

  // 记录哪些根会话已收到过"来自根自身"的标题（防止子会话标题覆盖根标题）
  const rootTitleOwned = new Set<string>()

  return {
    event: async ({ event }) => {
      // 会话创建/更新时记录标题与目录（供 HTTP 页面显示会话名称）
      if (event.type === "session.created" || event.type === "session.updated") {
        const info = (event as { properties?: { info?: { id?: string; title?: string; directory?: string; parentID?: string } } }).properties?.info
        if (info?.id) {
          // 记录父子关系（用于根系查找）
          if (info.parentID !== undefined) childMap.set(info.id, info.parentID)
          else if (!childMap.has(info.id)) childMap.set(info.id, undefined)

          // 标题仅来自根会话自身；子会话不覆盖根标题
          const root = findRoot(info.id)
          if (info.id === root) {
            rememberSessionMeta(root, info.title ?? "", info.directory ?? "")
            rootTitleOwned.add(root)
          } else if (!rootTitleOwned.has(root) && !sessionMeta.has(root)) {
            rememberSessionMeta(root, info.title ?? "", info.directory ?? "")
          }
          // 有活动终端时同步状态文件
          const map = getSessionMap(root)
          if (map) for (const name of map.keys()) syncSessionState(root, name, "session-meta")
        }
      }
      if (event.type === "session.deleted") {
        const props = (event as { properties?: { sessionID?: string; info?: { id?: string } } }).properties
        const sid = props?.sessionID ?? props?.info?.id
        if (sid) {
          childMap.delete(sid)
          const root = findRoot(sid)
          if (root === sid) {
            cleanupAllSessions(sid)
            cleanupAllLocalSessions(sid)
          }
          sessionMeta.delete(sid)
          rootTitleOwned.delete(sid)
          log.info(`会话 ${sid} 删除，根 ${root} 清理`)
        }
      }
    },
    tool: {
      term_cli: tool({
        description: T.term_cli[toolLang],
        args: {
          args: tool.schema.string().optional().describe(T.term_cli_args[toolLang]),
        },
        async execute(args, context) {
          return { title: "term_cli", output: await handleCliCommand(args.args ?? "help", context) }
        },
      }),
    },
  }
}

// 默认导出：opencode 加载插件优先取 mod.default（V1 格式），具名导出不一定被识别
export default OpenCodeSshTool