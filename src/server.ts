// 本地 HTTP 服务：浏览器直接查看可滚动终端记录（默认开启，端口可配，0=随机分配）

import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import type { SshSession } from "./session.js"
import { cleanAnsi } from "./utils.js"

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

/**
 * 启动 HTTP 服务（监听 127.0.0.1）
 * @param port 端口，0 或未指定 → 系统随机分配（避免冲突）
 * @param getSessions 获取扁平会话条目列表的函数（供页面展示）
 * @returns 服务句柄（含实际端口与 URL）
 */
export function startServer(port: number, getSessions: () => SessionEntry[]): Promise<ServerHandle> {
  let actualPort = port
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    const path = url.pathname

    if (path === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    if (path === "/api/status") {
      const entries = getSessions()
      // 按 sessionID 分组（一个会话下多个终端）
      const bySession = new Map<string, { title?: string; directory?: string; terminals: { name: string; host?: string; user?: string; port?: number; connected: boolean; busy: boolean; pending: number }[] }>()
      for (const { sessionID, name, session, title, directory } of entries) {
        const st = session.getStatus()
        if (!bySession.has(sessionID)) bySession.set(sessionID, { title, directory, terminals: [] })
        bySession.get(sessionID)!.terminals.push({ name, host: st.host, user: st.user, port: st.port, connected: st.connected, busy: st.busy, pending: st.pending })
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
      if (!entry) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
        res.end("Session not found or disconnected")
        return
      }
      // 渲染命令+输出消息对
      const lines: string[] = []
      for (const pair of entry.session.getHistory().getPairs()) {
        lines.push(`$ ${pair.command}`)
        lines.push(cleanAnsi(entry.session.getHistory().readOutput(pair)))
      }
      // 附加运行中命令的实时进度（busy 时）
      const running = entry.session.getRunningOutput()
      if (running) {
        lines.push("")
        lines.push(`[ 运行中 ] ${running}`)
      }
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" })
      res.end(lines.join("\n"))
      return
    }

    if (path === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      res.end(renderPage())
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

/** 渲染终端记录页面（黑底绿字等宽，JS 轮询自动刷新） */
function renderPage(): string {
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>SSH 终端记录</title>
<style>
  html, body { margin: 0; height: 100%; background: #0d1117; color: #c9d1d9; font-family: system-ui, sans-serif; }
  header { position: sticky; top: 0; display: flex; align-items: center; gap: 12px; padding: 10px 16px; background: #161b22; border-bottom: 1px solid #30363d; }
  header h1 { margin: 0; font-size: 14px; color: #e6edf3; font-weight: 600; }
  select { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; padding: 4px 8px; border-radius: 6px; }
  pre { margin: 0; padding: 16px; font-family: "Cascadia Code", Consolas, "Courier New", monospace; font-size: 13px; line-height: 1.5; white-space: pre; overflow: auto; height: calc(100% - 52px); box-sizing: border-box; color: #2fbf71; }
  #meta { font-size: 12px; color: #8b949e; }
</style>
</head>
<body>
<header>
  <h1>SSH 终端记录</h1>
  <select id="session" onchange="onSessionChange()"></select>
  <select id="terminal" onchange="loadTranscript()"></select>
  <span id="meta"></span>
</header>
<pre id="term">加载中...</pre>
<script>
  let sessionsData = [];

  function sessionLabel(s) {
    // 优先显示会话标题，其次 host@user，最后短 sessionID
    if (s.title && s.title.trim()) return s.title;
    const t = s.terminals && s.terminals[0];
    if (t && t.host) return (t.user ? t.user + "@" : "") + t.host;
    return s.sessionID.slice(0, 8) + "…";
  }

  async function loadSessions() {
    const r = await fetch("/api/status");
    const data = await r.json();
    sessionsData = data.sessions || [];
    const sel = document.getElementById("session");
    const prev = sel.value;
    sel.innerHTML = "";
    for (const s of sessionsData) {
      const opt = document.createElement("option");
      opt.value = s.sessionID;
      opt.textContent = sessionLabel(s) + "  (" + s.terminals.length + " 终端)";
      sel.appendChild(opt);
    }
    if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
    else sel.selectedIndex = sessionsData.length ? 0 : -1;
    onSessionChange();
  }

  function onSessionChange() {
    const sel = document.getElementById("session");
    const sid = sel.value;
    const tsel = document.getElementById("terminal");
    const prev = tsel.value;
    tsel.innerHTML = "";
    const s = sessionsData.find(x => x.sessionID === sid);
    for (const t of (s ? s.terminals : [])) {
      const opt = document.createElement("option");
      opt.value = t.name || "default";
      opt.textContent = (t.name || "default") + "  " + (t.connected ? "●" : "○") + (t.busy ? " ⏳" : "");
      tsel.appendChild(opt);
    }
    if (prev && [...tsel.options].some(o => o.value === prev)) tsel.value = prev;
    else tsel.selectedIndex = tsel.options.length ? 0 : -1;
    loadTranscript();
  }

  async function loadTranscript() {
    const sel = document.getElementById("session");
    const tsel = document.getElementById("terminal");
    const sid = sel.value;
    const name = tsel.value;
    if (!sid || !name) { document.getElementById("term").textContent = "无会话，请先 ssh_connect"; return; }
    const r = await fetch("/api/transcript?session=" + encodeURIComponent(sid) + "&name=" + encodeURIComponent(name));
    const text = await r.text();
    document.getElementById("term").textContent = text;
    document.getElementById("meta").textContent = sid + "/" + name + " · " + text.length + " 字符 · 每 2s 自动刷新";
    document.getElementById("term").scrollTop = document.getElementById("term").scrollHeight;
  }

  loadSessions();
  setInterval(loadTranscript, 2000);
  setInterval(loadSessions, 5000);
</script>
</body>
</html>`
}
