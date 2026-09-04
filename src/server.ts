// 本地 HTTP 服务：浏览器直接查看可滚动终端记录（默认开启，端口可配，0=随机分配）

import { createServer, type Server } from "node:http"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
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
      res.end(renderPage(lang))
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

/** 渲染终端记录页面（黑底绿字等宽，JS 轮询自动刷新），语言由配置 webLang 决定 */
function renderPage(lang: Lang): string {
  const w = (key: FlatKey) => tr(key, lang)
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<title>${w("web_title")}</title>
<link href="https://fonts.googleapis.com/css2?family=Cascadia+Code:wght@400;600&display=swap" rel="stylesheet">
<style>
  html, body { margin: 0; height: 100%; background: #0d1117; color: #c9d1d9; font-family: system-ui, sans-serif; }
  header { position: sticky; top: 0; display: flex; align-items: center; gap: 12px; padding: 10px 16px; background: #161b22; border-bottom: 1px solid #30363d; }
  header h1 { margin: 0; font-size: 14px; color: #e6edf3; font-weight: 600; }
  select { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; padding: 4px 8px; border-radius: 6px; }
  pre { margin: 0; padding: 16px; font-family: "Cascadia Code", "Fira Code", "JetBrains Mono", "Noto Sans Mono", "Hack", Consolas, "Courier New", monospace; font-size: 13px; line-height: 1.5; white-space: pre-wrap; overflow: auto; height: calc(100% - 52px); box-sizing: border-box; color: #c9d1d9; }
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
  <h1>${w("web_title")}</h1>
  <select id="session" onchange="onSessionChange(true)"></select>
  <select id="terminal" onchange="onSessionChange(true)"></select>
  <label class="tgl"><input type="checkbox" id="showTime" onchange="onShowTimeChange()"> ${w("web_time")}</label>
  <span id="meta"></span>
</header>
<pre id="term">${w("web_loading")}</pre>
<button id="toBottom" class="to-bottom-btn" onclick="scrollToNewest()">${w("web_new_messages")}</button>
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

  // 模板内嵌翻译值：预取为 JS 变量，避免字符串内插值引号冲突
  const L = {
    run: ${JSON.stringify(w("web_running"))},
    commands: ${JSON.stringify(w("web_commands"))},
    autoRefresh: ${JSON.stringify(w("web_auto_refresh"))},
    sessionGone: ${JSON.stringify(w("web_session_gone"))},
    noSession: ${JSON.stringify(w("web_no_session"))},
    loadFailed: ${JSON.stringify(w("web_load_failed"))},
  };

  // 轻量终端模拟：按真实终端语义渲染 ANSI 流（光标移动/清屏/颜色/制表符），原样还原屏幕画面
  const ANSI_BASE = ["#010101","#de382b","#39b54a","#ffc005","#006fb8","#762671","#2cb3e9","#c9d1d9"];
  const ANSI_BRIGHT = ["#666666","#ff7b72","#3fb950","#d29922","#58a6ff","#bc8cff","#39c5cf","#f0f6fc"];
  class TermScreen {
    constructor(cols) {
      this.cols = cols;               // 列数（超出自动折行，模拟终端 wrap）
      this.grid = [];                 // 每行: 数组(cols) of {ch, fg, bg, bold}
      this.r = 0;                     // 当前光标行
      this.c = 0;                     // 当前光标列
      this.fg = null; this.bg = null; this.bold = false;   // 当前 SGR 样式
    }
    // 确保某行存在
    _row(r) {
      while (this.grid.length <= r) {
        const row = [];
        for (let i = 0; i < this.cols; i++) row.push({ ch: " ", fg: null, bg: null, bold: false });
        this.grid.push(row);
      }
      return this.grid[r];
    }
    // 写一个字符到光标处（自动折行到下一行）
    _put(ch) {
      let row = this._row(this.r);
      row[this.c] = { ch, fg: this.fg, bg: this.bg, bold: this.bold };
      this.c++;
      if (this.c >= this.cols) { this.c = 0; this.r++; }
    }
    // 处理一段 ANSI 文本（增量喂入）
    write(text) {
      let i = 0;
      const n = text.length;
      while (i < n) {
        const ch = text[i];
        if (ch === "\\x1b") {
          // OSC: ESC ] ... BEL(0x07) 或 ESC \ —— 设置窗口标题等，不渲染，整段丢弃
          if (i + 1 < n && text[i + 1] === "]") {
            let j = i + 2;
            while (j < n && text[j] !== "\\x07" && !(text[j] === "\\x1b" && text[j + 1] === "\\\\")) j++;
            if (j >= n) break;
            i = text[j] === "\\x07" ? j + 1 : j + 2;
            continue;
          }
          // CSI: ESC [ params... final
          if (i + 1 < n && text[i + 1] === "[") {
            let j = i + 2;
            const start = j;
            while (j < n && !/[A-Za-z@]/.test(text[j])) j++;
            if (j >= n) break; // 不完整序列，忽略
            const body = text.slice(start, j);
            const final = text[j];
            this._csi(body, final);
            i = j + 1;
            continue;
          }
          // 其他 ESC 序列（如 ESC 7/8 保存恢复光标）直接忽略
          i += 2;
          continue;
        }
        if (ch === "\\r") { this.c = 0; i++; continue; }
        // ONLCR：数据层换行符不带回车，渲染时按终端默认行为归零列（否则出现递进缩进）
        if (ch === "\\n") { this.r++; this.c = 0; i++; continue; }
        if (ch === "\\b") { if (this.c > 0) this.c--; i++; continue; }
        if (ch === "\\t") { this.c = (Math.floor(this.c / 8) + 1) * 8; if (this.c >= this.cols) { this.c = 0; this.r++; } i++; continue; }
        // 控制字符（如 0x07 BEL）跳过
        if (ch.charCodeAt(0) < 32) { i++; continue; }
        this._put(ch);
        i++;
      }
    }
    // CSI 指令处理（含中间参数）
    _csi(body, final) {
      // 分离中参数（如 ？）：光标移动常用；这里简化为忽略问号开头
      const b = body.replace(/^[?]/ , "");
      // SGR: 颜色/样式
      if (final === "m") {
        const codes = b ? b.split(";").map(x => parseInt(x, 10)) : [0];
        if (!b || codes.indexOf(0) >= 0) { this.fg = null; this.bg = null; this.bold = false; }
        for (const c of codes) {
          if (c === 1) this.bold = true;
          else if (c === 22) this.bold = false;
          else if (c >= 30 && c <= 37) this.fg = ANSI_BASE[c - 30];
          else if (c === 39) this.fg = null;
          else if (c >= 90 && c <= 97) this.fg = ANSI_BRIGHT[c - 90];
          else if (c >= 40 && c <= 47) this.bg = ANSI_BASE[c - 40];
          else if (c === 49) this.bg = null;
          else if (c >= 100 && c <= 107) this.bg = ANSI_BRIGHT[c - 100];
        }
        return;
      }
      // 光标移动 / 定位
      const p = (d) => { const v = parseInt(d, 10); return (Number.isFinite(v) && v > 0) ? v : 1; };
      const va = (d) => { const v = parseInt(d, 10); return (Number.isFinite(v) && v >= 0) ? v : 0; };
      if (final === "A") this.r = Math.max(0, this.r - p(b));
      else if (final === "B") this.r += p(b);
      else if (final === "C") this.c = Math.min(this.cols - 1, this.c + p(b));
      else if (final === "D") this.c = Math.max(0, this.c - p(b));
      else if (final === "H" || final === "f") { const m = b.split(";"); this.r = p(m[0]) - 1; this.c = p(m[1]) - 1; }
      else if (final === "G" || final.charCodeAt(0) === 96) { this.c = Math.max(0, p(b) - 1); }
      else if (final === "d") { this.r = Math.max(0, p(b) - 1); }
      // 清屏/擦除
      else if (final === "J") {
        const mode = va(b);
        if (mode === 2 || mode === 3) { // 全清：所有行置空格
          for (let ri = 0; ri < this.grid.length; ri++) {
            const row = this._row(ri);
            for (let ci = 0; ci < this.cols; ci++) row[ci] = { ch: " ", fg: null, bg: null, bold: false };
          }
          this.r = 0; this.c = 0;
        } else if (mode === 1) { // 从屏首清到光标
          for (let ri = 0; ri <= this.r; ri++) {
            const row = this._row(ri);
            const end = (ri === this.r) ? this.c : this.cols;
            for (let ci = 0; ci < end; ci++) row[ci] = { ch: " ", fg: null, bg: null, bold: false };
          }
        } else { // mode 0: 光标到屏末
          for (let ri = this.r; ri < this.grid.length; ri++) {
            const row = this._row(ri);
            const start = (ri === this.r) ? this.c : 0;
            for (let ci = start; ci < this.cols; ci++) row[ci] = { ch: " ", fg: null, bg: null, bold: false };
          }
        }
      } else if (final === "K") {
        const mode = va(b);
        const row = this._row(this.r);
        if (mode === 2) { for (let ci = 0; ci < this.cols; ci++) row[ci] = { ch: " ", fg: null, bg: null, bold: false }; }
        else if (mode === 1) { for (let ci = 0; ci <= this.c; ci++) row[ci] = { ch: " ", fg: null, bg: null, bold: false }; }
        else { for (let ci = this.c; ci < this.cols; ci++) row[ci] = { ch: " ", fg: null, bg: null, bold: false }; }
      }
      // 其余 CSI（滚动/插入/删除/光标保存等）暂忽略，不影响内容显示
    }
    // 渲染为 HTML 行数组（尾部全空格行裁剪；跳过全空行以减小体积）
    // 返回 [ { row, html } ]：row 为网格行号，便于外部对特定行打标记（时间列）
    render() {
      const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const out = [];
      for (let ri = 0; ri < this.grid.length; ri++) {
        const row = this.grid[ri];
        let last = this.cols;
        while (last > 0 && row[last - 1].ch === " ") last--;
        if (last === 0) continue; // 空行跳过
        let html = "";
        let cur = null; // 当前样式段
        for (let ci = 0; ci < last; ci++) {
          const cell = row[ci];
          const style = [];
          if (cell.bold) style.push("font-weight:bold");
          if (cell.fg) style.push("color:" + cell.fg);
          if (cell.bg) style.push("background-color:" + cell.bg);
          const key = style.join(";");
          if (key !== cur) {
            if (cur) html += "</span>";
            cur = key;
            if (key) html += '<span style="' + key + '">';
          }
          html += esc(cell.ch);
        }
        if (cur) html += "</span>";
        out.push({ row: ri, html });
      }
      return out;
    }
  }

  // 将 transcript 命令/输出流渲染为连续终端画面（共享一个 TermScreen，保持光标/清屏状态连续），
  // 命令与输出合并为一块：命令回显（含提示符）+ 输出按真实终端顺序排列，不再分栏
  function renderTranscript(pairs, showTime) {
    const screen = new TermScreen(120);
    const marks = []; // { row, ts, run }：每个命令块起始行
    let lastEndNL = true; // 上一段文本末尾是否以 \\n 结尾（默认 true，第一段前不需要补）
    for (const p of pairs) {
      if (p.type === "cmd") {
        marks.push({ row: screen.r, ts: p.ts, run: false });
        continue;
      }
      if (p.type === "run") marks.push({ row: screen.r, ts: null, run: true });
      // 上一段不以 \\n 结尾时补换行，防止命令段间因缺换行拼接在同一网格行
      if (!lastEndNL && !p.text.startsWith("\\n")) screen.write("\\n");
      screen.write(p.text);
      lastEndNL = p.text.endsWith("\\n");
    }
    const rows = screen.render();
    // 按网格行号把标记映射到渲染行（命令块起始 → 该行时间列）
    const timeByRow = new Map();
    for (const m of marks) {
      const hit = rows.find((r) => r.row >= m.row);
      if (hit && !timeByRow.has(hit.row)) timeByRow.set(hit.row, m);
    }
    return rows
      .map((r) => {
        const m = timeByRow.get(r.row);
        const t = m && !m.run && showTime && m.ts ? fmtTime(m.ts) : "";
        const label = m && m.run ? L.run : "";
        return '<div class="row"><span class="t">' + t + '</span><span class="c">' + label + r.html + '</span></div>';
      })
      .join("");
  }

  function sessionLabel(s) {
    // 优先显示会话标题，其次 host@user，最后短 sessionID
    if (s.title && s.title.trim()) return s.title;
    const t = s.terminals && s.terminals[0];
    if (t && t.host) return (t.user ? t.user + "@" : "") + t.host;
    return s.sessionID.slice(0, 8) + "…";
  }

  async function loadSessions() {
    let data;
    try {
      const r = await fetch("/api/status");
      data = await r.json();
    } catch (e) {
      return;
    }
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
      opt.textContent = sessionLabel(s) + "  (" + s.terminals.length + " ${w("web_terminals")})";
      sel.appendChild(opt);
    }
    if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
    else sel.selectedIndex = sessionsData.length ? 0 : -1;
    onSessionChange(false);
  }

  // 剔除失效终端/会话（transcript notFound 时），自动重建下拉框并切到下一个可用项
  function dropDeadTerminal(sid, name) {
    const s = sessionsData.find(x => x.sessionID === sid);
    if (s) {
      s.terminals = s.terminals.filter(t => (t.name || "default") !== name);
      if (s.terminals.length === 0) sessionsData = sessionsData.filter(x => x.sessionID !== sid);
    }
    lastSessionsKey = "";
    const sel = document.getElementById("session");
    const prev = sel.value;
    sel.innerHTML = "";
    for (const s2 of sessionsData) {
      const opt = document.createElement("option");
      opt.value = s2.sessionID;
      opt.textContent = sessionLabel(s2) + "  (" + s2.terminals.length + " ${w("web_terminals")})";
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
      opt.textContent = (t.name || "default") + (t.kind === "local" ? " [${w("web_local")}]" : "") + "  " + (t.connected ? "●" : "○") + (t.busy ? " ⏳" : "");
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
    if (!sid || !name) { pre.textContent = L.noSession; return; }
    // 更新前判断是否贴底：用户已向上滚动离开底部则不自动下滚，保持当前位置
    if (pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30) stickToBottom = true;
    const showTime = document.getElementById("showTime").checked;
    document.body.classList.toggle("show-time", showTime);
    let data;
    try {
      const r = await fetch("/api/transcript?session=" + encodeURIComponent(sid) + "&name=" + encodeURIComponent(name));
      if (!r.ok) throw new Error("HTTP " + r.status);
      data = await r.json();
    } catch (e) {
      pre.textContent = L.loadFailed;
      return;
    }
    const pairs = data.pairs || [];
    // 会话已不存在（残留状态文件但记录已清）：提示并自动剔除该终端/会话
    if (data.notFound) {
      lastTranscript = "";
      pendingTop = 0;
      pre.innerHTML = '<div class="row"><span class="t"></span><span class="c">' + L.sessionGone + '</span></div>';
      document.getElementById("meta").textContent = "";
      dropDeadTerminal(sid, name);
      return;
    }
    // 渲染前旧内容完整高度 = 新消息顶部位置（旧内容不变时高度稳定）
    const prevHeight = pre.scrollHeight;
    // 内容是否有新变化（有新消息才显示悬浮按钮）
    const sig = JSON.stringify(pairs);
    const changed = sig !== lastTranscript;
    lastTranscript = sig;
    // 命令/输出合并为连续终端画面：共享 TermScreen 保持状态连续，时间戳标在命令块首行
    pre.innerHTML = renderTranscript(pairs, showTime);
    const cmdCount = pairs.filter((p) => p.type === "cmd").length;
    document.getElementById("meta").textContent = sid + "/" + name + " · " + cmdCount + " " + L.commands + " · " + L.autoRefresh;
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
