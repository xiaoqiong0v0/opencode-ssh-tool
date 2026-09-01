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

/**
 * 启动 HTTP 服务（监听 127.0.0.1）
 * @param port 端口，0 或未指定 → 系统随机分配（避免冲突）
 * @param getSessions 获取会话表的函数（供页面展示）
 * @returns 服务句柄（含实际端口与 URL）
 */
export function startServer(port: number, getSessions: () => Map<string, SshSession>): Promise<ServerHandle> {
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
      const sessions = getSessions()
      const list = [...sessions.entries()].map(([sid, s]) => {
        const st = s.getStatus()
        return { sessionID: sid, host: st.host, user: st.user, port: st.port, connected: st.connected, busy: st.busy, pending: st.pending }
      })
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ port: actualPort, sessions: list }))
      return
    }

    if (path === "/api/transcript") {
      const sid = url.searchParams.get("session") ?? ""
      const session = getSessions().get(sid)
      if (!session) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
        res.end("会话不存在或已断开")
        return
      }
      // 渲染命令+输出消息对
      const lines: string[] = []
      for (const pair of session.getHistory().getPairs()) {
        lines.push(`$ ${pair.command}`)
        lines.push(cleanAnsi(session.getHistory().readOutput(pair)))
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
  <select id="session" onchange="loadTranscript()"></select>
  <span id="meta"></span>
</header>
<pre id="term">加载中...</pre>
<script>
  let current = "";

  async function loadSessions() {
    const r = await fetch("/api/status");
    const data = await r.json();
    const sel = document.getElementById("session");
    const prev = sel.value;
    sel.innerHTML = "";
    for (const s of data.sessions) {
      const opt = document.createElement("option");
      opt.value = s.sessionID;
      opt.textContent = (s.host || "?") + (s.user ? "@" + s.user : "") + "  " + (s.connected ? "●" : "○");
      sel.appendChild(opt);
    }
    if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
    else current = sel.value || "";
    loadTranscript();
  }

  async function loadTranscript() {
    const sel = document.getElementById("session");
    const sid = sel.value;
    if (!sid) { document.getElementById("term").textContent = "无会话，请先 ssh_connect"; return; }
    const r = await fetch("/api/transcript?session=" + encodeURIComponent(sid));
    const text = await r.text();
    document.getElementById("term").textContent = text;
    document.getElementById("meta").textContent = sid + " · " + text.length + " 字符 · 每 2s 自动刷新";
    document.getElementById("term").scrollTop = document.getElementById("term").scrollHeight;
  }

  loadSessions();
  setInterval(loadTranscript, 2000);
  setInterval(loadSessions, 5000);
</script>
</body>
</html>`
}
