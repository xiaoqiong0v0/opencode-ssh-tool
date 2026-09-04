// 本地 HTTP 服务：浏览器直接查看可滚动终端记录（默认开启，端口可配，0=随机分配）
// 前端页面为独立 web/ 工程（esbuild 打包到 dist/web/），本文件仅负责：i18n 占位替换 + 静态资源分发 + JSON API

import { createServer, type Server } from "node:http"
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join, dirname, extname, normalize } from "node:path"
import { fileURLToPath } from "node:url"
import type { AddressInfo } from "node:net"
import type { SshSession } from "./session.js"
import { listAllSessions } from "./session-store.js"
import { tr, type FlatKey, type Lang } from "./i18n.js"

/** 服务实例信息 */
export interface ServerHandle {
  server: Server
  port: number
  url: string
  close(): void
}

/** 扁平会话条目（多终端：sessionID × name 一个条目） */
export interface SessionEntry {
  sessionID: string
  name: string
  session: SshSession
  title?: string
  directory?: string
}

/** 前端模板中需要替换的 i18n 占位键 */
const PAGE_KEYS: FlatKey[] = [
  "web_title",
  "web_loading",
  "web_time",
  "web_new_messages",
  "web_terminals",
  "web_local",
]

/** 前端 JS 内 I18N 对象键 → i18n key */
const JS_I18N_KEYS: Record<string, FlatKey> = {
  run: "web_running",
  commands: "web_commands",
  autoRefresh: "web_auto_refresh",
  sessionGone: "web_session_gone",
  noSession: "web_no_session",
  loadFailed: "web_load_failed",
  terminals: "web_terminals",
  local: "web_local",
}

/**
 * 启动 HTTP 服务（监听 127.0.0.1）
 * @param port 端口，0 或未指定 → 系统随机分配（避免冲突）
 * @param getSessions 获取扁平会话条目列表的函数（供本进程页面展示）
 * @param dir 插件缓存根目录（跨进程状态文件/历史文件所在处）
 * @param lang Web 界面语言（默认 en）
 * @returns 服务句柄（含实际端口与 URL）
 */
export function startServer(port: number, getSessions: () => SessionEntry[], dir: string, lang: Lang = "en"): Promise<ServerHandle> {
  let actualPort = port
  // 前端产物目录：dist/web（相对本模块 dist/server.js 的上一级）
  const webDir = join(dirname(fileURLToPath(import.meta.url)), "web")
  // 模板只读一次（dist/web/index.html），每次请求做 i18n 占位替换
  const pageTemplate = readTemplate(webDir)

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    const path = url.pathname

    if (path === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    if (path === "/api/status") {
      // 跨进程聚合：所有 opencode 进程写入的状态文件（含本进程，SSH + 本地/容器）
      const states = listAllSessions(dir)
      // 按 sessionID 分组（一个会话下多个终端）
      const bySession = new Map<string, { title?: string; directory?: string; terminals: { name: string; kind?: string; host?: string; user?: string; port?: number; program?: string; connected: boolean; busy: boolean; pending: number }[] }>()
      for (const s of states) {
        if (!bySession.has(s.sessionID)) bySession.set(s.sessionID, { title: s.title, directory: s.directory, terminals: [] })
        bySession.get(s.sessionID)!.terminals.push({ name: s.name, kind: s.kind, host: s.host, user: s.user, port: s.port, program: s.program, connected: s.connected, busy: s.busy, pending: s.pending })
      }
      const sessions = [...bySession.entries()].map(([sessionID, v]) => ({
        sessionID,
        title: v.title,
        directory: v.directory,
        terminals: v.terminals,
      }))
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ port: actualPort, sessions }))
      return
    }

    if (path === "/api/transcript") {
      const sid = url.searchParams.get("session") ?? ""
      const name = url.searchParams.get("name") ?? "default"
      const entry = getSessions().find((e) => e.sessionID === sid && e.name === name)
      let pairs: TranscriptPair[]
      if (!entry) {
        // 本进程无此会话句柄（其他进程的会话/复用服务）→ 从历史文件读取
        // 本地/容器会话的历史目录带 local- 前缀，需按状态里的 kind 探测
        const state = listAllSessions(dir).find((s) => s.sessionID === sid && s.name === name)
        const histName = state?.kind === "local" ? `local-${name}` : name
        pairs = readHistoryFromFile(dir, sid, histName) ?? []
        if (pairs.length === 0 && !state) {
          // 状态文件与历史都消失 = 会话真正删除，前端剔除该幽灵终端
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ pairs: [], notFound: true }))
          return
        }
      } else {
        // 命令+输出消息对（原始字节流，保留 ANSI，前端 TermScreen 忠实渲染）；运行中附加实时进度
        pairs = []
        for (const pair of entry.session.getHistory().getPairs()) {
          pairs.push({ type: "cmd", ts: pair.ts, text: pair.command })
          pairs.push({ type: "out", text: entry.session.getHistory().readOutput(pair) })
        }
        const running = entry.session.getRunningOutput()
        if (running) pairs.push({ type: "run", text: running })
      }
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ pairs }))
      return
    }

    if (path === "/") {
      const html = renderPage(lang, pageTemplate)
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      res.end(html)
      return
    }

    // 静态资源：/web/* → dist/web/*（JS/CSS/字体）
    if (path.startsWith("/web/")) {
      serveStatic(res, webDir, decodeURIComponent(path.slice("/web/".length)))
      return
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
    res.end("Not Found")
  })

  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo
      actualPort = addr.port
      server.removeListener("error", reject)
      resolve({
        server,
        port: actualPort,
        url: `http://127.0.0.1:${actualPort}`,
        close: () => server.close(),
      })
    })
  })
}

/** transcript 消息项：cmd 命令 / out 输出 / run 运行中 */
interface TranscriptPair {
  type: "cmd" | "out" | "run"
  ts?: number
  text: string
}

/**
 * 渲染终端记录页面：读取编译后的 index.html，替换 i18n 占位符与前端 I18N 对象
 * @param lang 界面语言
 * @param template index.html 模板文本（启动时已读）
 * @returns 最终 HTML 文本
 */
function renderPage(lang: Lang, template: string): string {
  let out = template
  // 语言占位
  out = out.replaceAll("{{lang}}", lang)
  // 文本占位（{{web_xxx}}）
  for (const key of PAGE_KEYS) {
    out = out.replaceAll(`{{${key}}}`, tr(key, lang))
  }
  // 前端 JS I18N 对象（window.__I18N__ = ...）
  const i18nObj: Record<string, string> = {}
  for (const [jsKey, i18nKey] of Object.entries(JS_I18N_KEYS)) {
    i18nObj[jsKey] = tr(i18nKey, lang)
  }
  out = out.replaceAll("__I18N_JSON__", JSON.stringify(i18nObj))
  return out
}

/** 读取前端模板（dist/web/index.html）；缺失时返回引导构建的提示页 */
function readTemplate(webDir: string): string {
  const file = join(webDir, "index.html")
  if (!existsSync(file)) {
    return `<!DOCTYPE html><html><body><h1>Web assets not built</h1><p>Run <code>npm run build</code> to build the web frontend.</p></body></html>`
  }
  return readFileSync(file, "utf8")
}

/** 静态文件类型映射 */
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
}

/**
 * 分发静态资源（防目录穿越：归一化后校验目标在 webDir 内）
 * @param res 响应对象
 * @param webDir 前端产物根目录
 * @param rel 相对路径（已去 /web/ 前缀）
 */
function serveStatic(res: import("node:http").ServerResponse, webDir: string, rel: string): void {
  if (rel.includes("\0")) {
    res.writeHead(400)
    res.end("Bad Request")
    return
  }
  const file = normalize(join(webDir, rel))
  if (!file.startsWith(webDir + "\\") && !file.startsWith(webDir + "/") && file !== webDir) {
    res.writeHead(403)
    res.end("Forbidden")
    return
  }
  if (!existsSync(file)) {
    res.writeHead(404)
    res.end("Not Found")
    return
  }
  const ext = extname(file).toLowerCase()
  res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" })
  res.end(readFileSync(file))
}

/**
 * 从历史文件读取某终端记录（跨进程场景：本进程无该会话句柄时用）
 * @param dir 插件缓存根目录
 * @param sessionID opencode 会话 ID
 * @param name 终端名（已含 local- 前缀则按本地目录）
 * @returns 结构化消息对（保留 ANSI）；目录不存在返回 null
 */
function readHistoryFromFile(dir: string, sessionID: string, name: string): TranscriptPair[] | null {
  const hdir = join(dir, sessionID, name)
  let files: string[]
  try {
    files = readdirSync(hdir).filter((f) => f.endsWith(".json"))
  } catch {
    return null
  }
  files.sort()
  const out: TranscriptPair[] = []
  for (const f of files) {
    try {
      const data = JSON.parse(readFileSync(join(hdir, f), "utf8")) as { command?: string; output?: string; ts?: number }
      if (typeof data.command === "string") out.push({ type: "cmd", ts: data.ts ?? Date.now(), text: data.command })
      if (typeof data.output === "string") out.push({ type: "out", text: data.output })
    } catch {
      /* 跳过损坏文件 */
    }
  }
  return out
}
