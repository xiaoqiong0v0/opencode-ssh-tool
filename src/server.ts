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
        if (pairs.length === 0) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
          res.end("Session not found or disconnected")
          return
        }
      } else {
        // 命令+输出消息对（保留 ANSI 颜色，前端解析着色）；运行中附加实时进度
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

/** transcript 消息项：cmd 命令 / out 输出 / run 运行中 */
interface TranscriptPair {
  type: "cmd" | "out" | "run"
  ts?: number
  text: string
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
  pre { margin: 0; padding: 16px; font-family: "Cascadia Code", Consolas, "Courier New", monospace; font-size: 13px; line-height: 1.5; white-space: pre-wrap; overflow: auto; height: calc(100% - 52px); box-sizing: border-box; color: #c9d1d9; }
  /* 两列布局：左侧时间列（开关控制显隐），右侧内容列（命令/输出格式不变） */
  .row { display: flex; align-items: stretch; }
  .row .t { box-sizing: border-box; flex: 0 0 172px; color: #8b949e; padding: 0 10px 0 6px; border-right: 1px solid #30363d; white-space: pre; }
  .row .c { flex: 1; padding-left: 12px; white-space: pre; }
  body:not(.show-time) .row .t { display: none; }
  /* 命令行：明显区分（背景条 + 左侧蓝条 + 加粗）；用 box-shadow 不占布局，保证时间列/分割线与输出行完全对齐 */
  .row.cmdline { background: #161b22; box-shadow: inset 3px 0 0 #58a6ff; font-weight: 600; }
  .tgl { font-size: 12px; color: #8b949e; display: flex; align-items: center; gap: 4px; white-space: nowrap; }
  #meta { font-size: 12px; color: #8b949e; }
  /* 深色细滚动条：匹配暗色主题 */
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: #161b22; }
  ::-webkit-scrollbar-thumb { background: #30363d; border-radius: 5px; border: 2px solid #161b22; }
  ::-webkit-scrollbar-thumb:hover { background: #484f58; }
  ::-webkit-scrollbar-corner { background: #161b22; }
  * { scrollbar-width: thin; scrollbar-color: #30363d #161b22; }
  /* 回到底部悬浮按钮：离开底部且有新消息时显示 */
  .to-bottom-btn {
    position: fixed; right: 24px; bottom: 24px; display: none;
    background: #238636; color: #fff; border: none; border-radius: 20px;
    padding: 8px 16px; font-size: 13px; cursor: pointer; z-index: 10;
    box-shadow: 0 4px 12px rgba(0,0,0,.4);
  }
  .to-bottom-btn:hover { background: #2ea043; }
</style>
</head>
<body>
<header>
  <h1>终端记录</h1>
  <select id="session" onchange="onSessionChange(true)"></select>
  <select id="terminal" onchange="onSessionChange(true)"></select>
  <label class="tgl"><input type="checkbox" id="showTime" onchange="onShowTimeChange()"> 时间</label>
  <span id="meta"></span>
</header>
<pre id="term">加载中...</pre>
<button id="toBottom" class="to-bottom-btn" onclick="scrollToNewest()">↓ 新消息</button>
<script>
  let sessionsData = [];
  // 是否贴底（用户向上滚动查看历史时不自动下滚，仅贴底时跟随新输出）
  let stickToBottom = true;
  // 上次会话列表指纹（无变化则不重建下拉框，避免打断用户选择/焦点）
  let lastSessionsKey = "";
  // 上次渲染的 transcript 文本（判断是否真有新消息才显示悬浮按钮）
  let lastTranscript = "";
  // 新消息顶部位置（点击悬浮按钮时滚动到此处，而非底部）
  let pendingTop = 0;

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
    onSessionChange(false);
  }

  function onSessionChange(forceStick) {
    lastTranscript = "";
    pendingTop = 0;
    const sel = document.getElementById("session");
    const sid = sel.value;
    const tsel = document.getElementById("terminal");
    const prev = tsel.value;
    tsel.innerHTML = "";
    const s = sessionsData.find(x => x.sessionID === sid);
    for (const t of (s ? s.terminals : [])) {
      const opt = document.createElement("option");
      opt.value = t.name || "default";
      opt.textContent = (t.name || "default") + (t.kind === "local" ? " [本地]" : "") + "  " + (t.connected ? "●" : "○") + (t.busy ? " ⏳" : "");
      tsel.appendChild(opt);
    }
    if (prev && [...tsel.options].some(o => o.value === prev)) tsel.value = prev;
    else tsel.selectedIndex = tsel.options.length ? 0 : -1;
    // 仅用户主动切换会话/终端时强制回到底部；自动轮询重建不打扰当前滚动位置
    if (forceStick) stickToBottom = true;
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
    const showTime = document.getElementById("showTime").checked;
    document.body.classList.toggle("show-time", showTime);
    const r = await fetch("/api/transcript?session=" + encodeURIComponent(sid) + "&name=" + encodeURIComponent(name));
    const data = await r.json();
    const pairs = data.pairs || [];
    // 渲染前旧内容完整高度 = 新消息顶部位置（旧内容不变时高度稳定）
    const prevHeight = pre.scrollHeight;
    // 内容是否有新变化（有新消息才显示悬浮按钮）
    const sig = JSON.stringify(pairs);
    const changed = sig !== lastTranscript;
    lastTranscript = sig;
    pre.innerHTML = pairs.map((p) => {
      if (p.type === "cmd") {
        const t = showTime ? fmtTime(p.ts) : "";
        return '<div class="row cmdline"><span class="t">' + t + '</span><span class="c">' + ansiToHtml(p.text) + '</span></div>';
      }
      // out / run：输出列，保留 ANSI 彩色，时间列留空（不改变输出格式）
      const label = p.type === "run" ? "[运行中] " : "";
      return '<div class="row"><span class="t"></span><span class="c">' + label + ansiToHtml(p.text) + '</span></div>';
    }).join("");
    const cmdCount = pairs.filter((p) => p.type === "cmd").length;
    document.getElementById("meta").textContent = sid + "/" + name + " · " + cmdCount + " 条命令 · 每 2s 自动刷新";
    if (stickToBottom) {
      pre.scrollTop = pre.scrollHeight;
      toBottomBtn.style.display = "none";
    } else if (pendingTop > 0) {
      // 离开底部且有未读新消息 → 显示悬浮按钮（pendingTop 为跳转位置）
      toBottomBtn.style.display = "block";
    }
    // 无论贴底与否，有内容变化都记录新消息顶部（供用户滚上去后跳转）
    if (changed && pre.scrollHeight > pre.clientHeight) {
      pendingTop = prevHeight;
      if (stickToBottom) {
        // 贴底跟随 = 已读到最新，清除未读标记（用户滚上去才重新提示）
        pendingTop = 0;
      }
    }
  }

  // 时间戳格式化 yyyy-MM-dd HH:mm:ss
  function fmtTime(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  // 时间开关：localStorage 持久化，刷新页面保持状态
  function onShowTimeChange() {
    const el = document.getElementById("showTime");
    localStorage.setItem("showTime", el.checked ? "1" : "0");
    document.body.classList.toggle("show-time", el.checked);
    loadTranscript();
  }
  document.getElementById("showTime").checked = localStorage.getItem("showTime") === "1";
  document.body.classList.toggle("show-time", document.getElementById("showTime").checked);

  // 用户滚动：贴底 → 恢复跟随并隐藏按钮；离开底部 → 取消自动贴底
  const termPre = document.getElementById("term");
  const toBottomBtn = document.getElementById("toBottom");
  termPre.addEventListener("scroll", () => {
    if (termPre.scrollTop + termPre.clientHeight >= termPre.scrollHeight - 30) {
      stickToBottom = true;
      toBottomBtn.style.display = "none";
      pendingTop = 0; // 贴底 = 已读到最新，清除未读标记
    } else {
      stickToBottom = false;
    }
  });
  // 点击悬浮按钮：滚动到新消息顶部（阅读未读内容），不强制回到底部
  function scrollToNewest() {
    termPre.scrollTop = pendingTop > 0 ? pendingTop : termPre.scrollHeight;
    pendingTop = 0;
    toBottomBtn.style.display = "none";
  }

  loadSessions();
  setInterval(loadTranscript, 2000);
  setInterval(loadSessions, 5000);
</script>
</body>
</html>`
}
