// 本地 HTTP 服务：浏览器直接查看可滚动终端记录（默认开启，端口可配，0=随机分配）

import { createServer, type Server } from "node:http"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { AddressInfo } from "node:net"
import type { SshSession } from "./session.js"
import { listAllSessions } from "./session-store.js"

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
 * @param getSessions 获取扁平会话条目列表的函数（供本进程页面展示）
 * @param dir 插件缓存根目录（跨进程状态文件/历史文件所在处）
 * @returns 服务句柄（含实际端口与 URL）
 */
export function startServer(port: number, getSessions: () => SessionEntry[], dir: string): Promise<ServerHandle> {
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
      // 跨进程聚合：所有 opencode 进程写入的状态文件（含本进程）
      const states = listAllSessions(dir)
      // 按 sessionID 分组（一个会话下多个终端）
      const bySession = new Map<string, { title?: string; directory?: string; terminals: { name: string; host?: string; user?: string; port?: number; connected: boolean; busy: boolean; pending: number }[] }>()
      for (const s of states) {
        if (!bySession.has(s.sessionID)) bySession.set(s.sessionID, { title: s.title, directory: s.directory, terminals: [] })
        bySession.get(s.sessionID)!.terminals.push({ name: s.name, host: s.host, user: s.user, port: s.port, connected: s.connected, busy: s.busy, pending: s.pending })
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
        // 本进程无此会话句柄（其他进程的会话/复用服务）→ 从历史文件读取
        const text = readHistoryFromFile(dir, sid, name)
        if (text === null) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
          res.end("Session not found or disconnected")
          return
        }
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" })
        res.end(text)
        return
      }
      // 渲染命令+输出消息对（保留 ANSI 颜色，前端解析着色）
      const lines: string[] = []
      for (const pair of entry.session.getHistory().getPairs()) {
        lines.push(`$ ${pair.command}`)
        lines.push(entry.session.getHistory().readOutput(pair))
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

/**
 * 从历史文件读取某终端记录（跨进程场景：本进程无该会话句柄时用）
 * @param dir 插件缓存根目录
 * @param sessionID opencode 会话 ID
 * @param name 终端名
 * @returns 渲染文本（命令+输出，去除 ANSI）；目录不存在返回 null
 */
function readHistoryFromFile(dir: string, sessionID: string, name: string): string | null {
  const hdir = join(dir, sessionID, name)
  let files: string[]
  try {
    files = readdirSync(hdir).filter((f) => f.endsWith(".json"))
  } catch {
    return null
  }
  files.sort()
  const lines: string[] = []
  for (const f of files) {
    try {
      const data = JSON.parse(readFileSync(join(hdir, f), "utf8")) as { command?: string; output?: string }
      if (typeof data.command === "string") lines.push(`$ ${data.command}`)
      if (typeof data.output === "string") lines.push(data.output)
    } catch {
      /* 跳过损坏文件 */
    }
  }
  return lines.join("\n")
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
  pre { margin: 0; padding: 16px; font-family: "Cascadia Code", Consolas, "Courier New", monospace; font-size: 13px; line-height: 1.5; white-space: pre; overflow: auto; height: calc(100% - 52px); box-sizing: border-box; color: #c9d1d9; }
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
  // 是否贴底（用户向上滚动查看历史时不自动下滚，仅贴底时跟随新输出）
  let stickToBottom = true;
  // 上次会话列表指纹（无变化则不重建下拉框，避免打断用户选择/焦点）
  let lastSessionsKey = "";

  // ANSI → 彩色 HTML：消费所有 CSI 序列（颜色/光标/清屏等），SGR 着色、其余丢弃；先 HTML 转义防 XSS
  const ANSI_BASE = ["#010101","#de382b","#39b54a","#ffc005","#006fb8","#762671","#2cb3e9","#c9d1d9"];
  const ANSI_BRIGHT = ["#666666","#ff7b72","#3fb950","#d29922","#58a6ff","#bc8cff","#39c5cf","#f0f6fc"];
  function ansiToHtml(s) {
    const esc = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const re = /\\x1b\\[[0-9;?]*[A-Za-z]/g;
    let fg = null, bg = null, bold = false, last = 0, m;
    const parts = [];
    const flush = (end) => {
      const text = esc.slice(last, end);
      last = end;
      if (!text) return;
      const style = [];
      if (bold) style.push("font-weight:bold");
      if (fg) style.push("color:" + fg);
      if (bg) style.push("background-color:" + bg);
      parts.push(style.length ? '<span style="' + style.join(";") + '">' + text + "</span>" : text);
    };
    while ((m = re.exec(esc))) {
      flush(m.index);
      const seq = m[0];
      // 仅 SGR（结尾 m）改颜色，其余 CSI（光标/清屏/括号粘贴等）丢弃
      if (seq.endsWith("m")) {
        const body = seq.slice(2, -1);
        const codes = body ? body.split(";").map(x => parseInt(x, 10)) : [0];
        if (!body || codes.indexOf(0) >= 0) { fg = null; bg = null; bold = false; }
        for (const c of codes) {
          if (c === 1) bold = true;
          else if (c === 22) bold = false;
          else if (c >= 30 && c <= 37) fg = ANSI_BASE[c - 30];
          else if (c === 39) fg = null;
          else if (c >= 90 && c <= 97) fg = ANSI_BRIGHT[c - 90];
          else if (c >= 40 && c <= 47) bg = ANSI_BASE[c - 40];
          else if (c === 49) bg = null;
          else if (c >= 100 && c <= 107) bg = ANSI_BRIGHT[c - 100];
        }
      }
      // 关键：跳过序列本身，避免真实 ESC 残留（浏览器显示为"口"）
      last = re.lastIndex;
    }
    flush(esc.length);
    return parts.join("");
  }

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
    const newSessions = data.sessions || [];
    const sel = document.getElementById("session");
    // 会话指纹未变化则跳过重建（保留用户选择与焦点）
    const key = newSessions.map(s => s.sessionID + "|" + s.terminals.length).join(",");
    if (key === lastSessionsKey) return;
    lastSessionsKey = key;
    sessionsData = newSessions;
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
    // 切换会话/终端：强制回到底部
    stickToBottom = true;
    loadTranscript();
  }

  async function loadTranscript() {
    const pre = document.getElementById("term");
    const sel = document.getElementById("session");
    const tsel = document.getElementById("terminal");
    const sid = sel.value;
    const name = tsel.value;
    if (!sid || !name) { pre.textContent = "无会话，请先 ssh_connect"; return; }
    // 更新前判断是否贴底：用户已向上滚动离开底部则不自动下滚，保持当前位置
    if (pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30) stickToBottom = true;
    const r = await fetch("/api/transcript?session=" + encodeURIComponent(sid) + "&name=" + encodeURIComponent(name));
    const text = await r.text();
    pre.innerHTML = ansiToHtml(text);
    document.getElementById("meta").textContent = sid + "/" + name + " · " + text.length + " 字符 · 每 2s 自动刷新";
    if (stickToBottom) pre.scrollTop = pre.scrollHeight;
  }

  loadSessions();
  setInterval(loadTranscript, 2000);
  setInterval(loadSessions, 5000);
</script>
</body>
</html>`
}
