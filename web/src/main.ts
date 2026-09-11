// 前端入口：纯 WebSocket 驱动（无 HTTP 轮询/断线重连），TermScreen 实时渲染

interface I18n {
  run: string
  commands: string
  autoRefresh: string
  sessionGone: string
  noSession: string
  loadFailed: string
  terminals: string
  local: string
}

interface TerminalInfo {
  name: string
  kind?: string
  host?: string
  user?: string
  port?: number
  program?: string
  connected: boolean
  busy: boolean
}

interface SessionStatus {
  sessionID: string
  title?: string
  directory?: string
  terminals: TerminalInfo[]
}

interface TranscriptPair {
  type: "cmd" | "out" | "run" | "sep"
  ts?: number
  endTs?: number
  text: string
}

/** 从原始终端输出中提取退出码和剥离标记后的文本 */
function parseOutput(raw: string): { text: string; exitCode?: number } {
  const m = raw.match(DONE_RE)
  if (m && m.length > 0) {
    const code = parseInt(m[m.length - 1].replace(/<SSH_DONE:|>/g, ""), 10)
    return { text: raw.replace(DONE_RE, ""), exitCode: isNaN(code) ? undefined : code }
  }
  return { text: raw }
}

interface GridCell {
  ch: string
  fg: string | null
  bg: string | null
  bold: boolean
}

const I18N: I18n = (window as unknown as { __I18N__: I18n }).__I18N__
const PTY_COLS: number = (window as unknown as { __PTY_COLS__: number }).__PTY_COLS__ || 120

const ANSI_BASE = ["#010101", "#de382b", "#39b54a", "#ffc005", "#006fb8", "#762671", "#2cb3e9", "#c9d1d9"]
const ANSI_BRIGHT = ["#666666", "#ff7b72", "#3fb950", "#d29922", "#58a6ff", "#bc8cff", "#39c5cf", "#f0f6fc"]

class TermScreen {
  private cols: number
  private grid: GridCell[][] = []
  private r = 0
  private c = 0
  private fg: string | null = null
  private bg: string | null = null
  private bold = false

  constructor(cols: number) {
    this.cols = cols
  }

  private _row(r: number): GridCell[] {
    while (this.grid.length <= r) {
      const row: GridCell[] = []
      for (let i = 0; i < this.cols; i++) row.push({ ch: " ", fg: null, bg: null, bold: false })
      this.grid.push(row)
    }
    return this.grid[r]
  }

  private _put(ch: string): void {
    const row = this._row(this.r)
    row[this.c] = { ch, fg: this.fg, bg: this.bg, bold: this.bold }
    this.c++
    if (this.c >= this.cols) {
      this.c = 0
      this.r++
    }
  }

  write(text: string): void {
    let i = 0
    const n = text.length
    while (i < n) {
      const ch = text[i]
      if (ch === "\x1b") {
        if (i + 1 < n && text[i + 1] === "]") {
          let j = i + 2
          while (j < n && text[j] !== "\x07" && !(text[j] === "\x1b" && text[j + 1] === "\\")) j++
          if (j >= n) break
          i = text[j] === "\x07" ? j + 1 : j + 2
          continue
        }
        if (i + 1 < n && text[i + 1] === "[") {
          let j = i + 2
          const start = j
          while (j < n && !/[A-Za-z@]/.test(text[j])) j++
          if (j >= n) break
          this._csi(text.slice(start, j), text[j])
          i = j + 1
          continue
        }
        i += 2
        continue
      }
      if (ch === "\r") { this.c = 0; i++; continue }
      if (ch === "\n") { this.r++; this.c = 0; i++; continue }
      if (ch === "\b") { if (this.c > 0) this.c--; i++; continue }
      if (ch === "\t") {
        this.c = (Math.floor(this.c / 8) + 1) * 8
        if (this.c >= this.cols) { this.c = 0; this.r++ }
        i++
        continue
      }
      if (ch.charCodeAt(0) < 32) { i++; continue }
      this._put(ch)
      i++
    }
  }

  private _csi(body: string, final: string): void {
    const b = body.replace(/^[?]/, "")
    if (final === "m") {
      const codes = b ? b.split(";").map((x) => parseInt(x, 10)) : [0]
      if (!b || codes.indexOf(0) >= 0) { this.fg = null; this.bg = null; this.bold = false }
      for (const code of codes) {
        if (code === 1) this.bold = true
        else if (code === 22) this.bold = false
        else if (code >= 30 && code <= 37) this.fg = ANSI_BASE[code - 30]
        else if (code === 39) this.fg = null
        else if (code >= 90 && code <= 97) this.fg = ANSI_BRIGHT[code - 90]
        else if (code >= 40 && code <= 47) this.bg = ANSI_BASE[code - 40]
        else if (code === 49) this.bg = null
        else if (code >= 100 && code <= 107) this.bg = ANSI_BRIGHT[code - 100]
      }
      return
    }
    const p = (d: string): number => { const v = parseInt(d, 10); return Number.isFinite(v) && v > 0 ? v : 1 }
    const va = (d: string): number => { const v = parseInt(d, 10); return Number.isFinite(v) && v >= 0 ? v : 0 }
    if (final === "A") this.r = Math.max(0, this.r - p(b))
    else if (final === "B") this.r += p(b)
    else if (final === "C") this.c = Math.min(this.cols - 1, this.c + p(b))
    else if (final === "D") this.c = Math.max(0, this.c - p(b))
    else if (final === "H" || final === "f") {
      const m = b.split(";")
      this.r = p(m[0]) - 1
      this.c = p(m[1]) - 1
    }
    else if (final === "G" || final.charCodeAt(0) === 96) this.c = Math.max(0, p(b) - 1)
    else if (final === "d") this.r = Math.max(0, p(b) - 1)
    else if (final === "J") {
      const mode = va(b)
      if (mode === 2 || mode === 3) {
        for (let ri = 0; ri < this.grid.length; ri++) {
          const row = this._row(ri)
          for (let ci = 0; ci < this.cols; ci++) row[ci] = { ch: " ", fg: null, bg: null, bold: false }
        }
        this.r = 0
        this.c = 0
      } else if (mode === 1) {
        for (let ri = 0; ri <= this.r; ri++) {
          const row = this._row(ri)
          const end = ri === this.r ? this.c : this.cols
          for (let ci = 0; ci < end; ci++) row[ci] = { ch: " ", fg: null, bg: null, bold: false }
        }
      } else {
        for (let ri = this.r; ri < this.grid.length; ri++) {
          const row = this._row(ri)
          const start = ri === this.r ? this.c : 0
          for (let ci = start; ci < this.cols; ci++) row[ci] = { ch: " ", fg: null, bg: null, bold: false }
        }
      }
    } else if (final === "K") {
      const mode = va(b)
      const row = this._row(this.r)
      if (mode === 2) {
        for (let ci = 0; ci < this.cols; ci++) row[ci] = { ch: " ", fg: null, bg: null, bold: false }
      } else if (mode === 1) {
        for (let ci = 0; ci <= this.c; ci++) row[ci] = { ch: " ", fg: null, bg: null, bold: false }
      } else {
        for (let ci = this.c; ci < this.cols; ci++) row[ci] = { ch: " ", fg: null, bg: null, bold: false }
      }
    }
  }

  render(): string[] {
    const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    const out: string[] = []
    for (let ri = 0; ri < this.grid.length; ri++) {
      const row = this.grid[ri]
      let last = this.cols
      while (last > 0 && row[last - 1].ch === " ") last--
      if (last === 0) continue
      let html = ""
      let cur: string | null = null
      for (let ci = 0; ci < last; ci++) {
        const cell = row[ci]
        const style: string[] = []
        if (cell.bold) style.push("font-weight:bold")
        if (cell.fg) style.push("color:" + cell.fg)
        if (cell.bg) style.push("background-color:" + cell.bg)
        const key = style.join(";")
        if (key !== cur) {
          if (cur) html += "</span>"
          cur = key
          if (key) html += '<span style="' + key + '">'
        }
        html += esc(cell.ch)
      }
      if (cur) html += "</span>"
      out.push(html)
    }
    return out
  }
}

// ===== 全局状态 =====
let ws: WebSocket | null = null
let sessionsData: SessionStatus[] = []
let stickToBottom = true
let runScreen: TermScreen | null = null
let debugMode = false

// ===== WS 连接 =====
function connectWs(): void {
  ws = new WebSocket("ws://" + window.location.host + "/ws")
  ws.onopen = () => {
    ws!.send(JSON.stringify({ type: "list" }))
    subscribe()
  }
  ws.onmessage = (ev) => {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(ev.data as string) as Record<string, unknown>
    } catch {
      return
    }
    switch (msg.type) {
      case "sessions": updateSessions(msg as unknown as { sessions: SessionStatus[] }); break
      case "snapshot": handleSnapshot(msg as unknown as { sessionID: string; name: string; pairs: TranscriptPair[]; notFound?: boolean }); break
      case "run": handleRun(msg as unknown as { data: string }); break
      case "runEnd": /* 等待后续 snapshot */ break
      case "cmdStart": handleCmdStart(msg as unknown as { command: string }); break
      case "raw": handleRaw(msg as unknown as { data: string; reset?: boolean }); break
    }
  }
  ws.onclose = () => {
    // 断线不做重连，页面死掉用户刷新
    const pre = document.getElementById("term") as HTMLPreElement
    pre.textContent = "WebSocket disconnected"
  }
}

// ===== 会话列表更新 =====
function updateSessions(msg: { sessions: SessionStatus[] }): void {
  const newSessions = msg.sessions || []
  const sel = document.getElementById("session") as HTMLSelectElement
  const key = newSessions.map((s) => s.sessionID + "|" + s.terminals.length).join(",")
  const prev = sel.value
  const prevTerminal = (document.getElementById("terminal") as HTMLSelectElement).value
  sessionsData = newSessions
  sel.innerHTML = ""
  for (const s of sessionsData) {
    const opt = document.createElement("option")
    opt.value = s.sessionID
    opt.textContent = sessionLabel(s) + "  (" + s.terminals.length + " " + I18N.terminals + ")"
    sel.appendChild(opt)
  }
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev
  else sel.selectedIndex = sessionsData.length ? 0 : -1
  updateTerminalSelect(prevTerminal)
}

function updateTerminalSelect(prevName?: string): void {
  const sel = document.getElementById("session") as HTMLSelectElement
  const tsel = document.getElementById("terminal") as HTMLSelectElement
  const delBtn = document.getElementById("delTerm") as HTMLButtonElement
  const sid = sel.value
  const s = sessionsData.find((x) => x.sessionID === sid)
  tsel.innerHTML = ""
  for (const t of (s ? s.terminals : [])) {
    const opt = document.createElement("option")
    opt.value = t.name || "default"
    opt.textContent = (t.name || "default") + (t.kind === "local" ? " [" + I18N.local + "]" : "") + "  " + (t.connected ? "●" : "○") + (t.busy ? " ⏳" : "")
    tsel.appendChild(opt)
  }
  if (prevName && [...tsel.options].some((o) => o.value === prevName)) tsel.value = prevName
  else tsel.selectedIndex = tsel.options.length ? 0 : -1
  // 删除按钮：仅非 default 且已断开时显示
  const cur = s?.terminals.find((t) => (t.name || "default") === tsel.value)
  delBtn.classList.toggle("show", !!(cur && !cur.connected))
  subscribe()
}

let subSid = ""
let subName = ""
/** 是否已收到 raw 流（收到前可回退 snapshot 渲染，收到后 raw 拥有画面） */
let rawActive = false

function subscribe(): void {
  const sid = (document.getElementById("session") as HTMLSelectElement).value
  const name = (document.getElementById("terminal") as HTMLSelectElement).value
  if (!sid || !name || !ws || ws.readyState !== WebSocket.OPEN) return
  if (sid === subSid && name === subName) return
  subSid = sid
  subName = name
  runScreen = null
  rawActive = false
  ws.send(JSON.stringify({ type: "subscribe", sessionID: sid, name, raw: debugMode }))
}

// ===== Snapshot 处理 =====
function handleSnapshot(msg: { sessionID: string; name: string; pairs: TranscriptPair[]; notFound?: boolean }): void {
  const pre = document.getElementById("term") as HTMLPreElement
  const toBottomBtn = document.getElementById("toBottom") as HTMLButtonElement
  if (msg.notFound) {
    pre.innerHTML = '<div class="row"><span class="t"></span><span class="c">' + I18N.sessionGone + '</span></div>'
    document.getElementById("meta").textContent = ""
    dropDeadTerminal(msg.sessionID, msg.name)
    return
  }
  const pairs = msg.pairs || []
  // Raw/debug 模式下时间列失效（时间随命令分块语义，与连续流/字节视图冲突）
  const showTime = !debugMode && (document.getElementById("showTime") as HTMLInputElement).checked
  document.body.classList.toggle("show-time", showTime)
  const cmdCount = pairs.filter((p) => p.type === "cmd").length
  document.getElementById("meta").textContent = msg.sessionID + "/" + msg.name + " · " + cmdCount + " " + I18N.commands
  // debug 模式下 raw 连续流优先：raw 数据渲染画面，snapshot 不再重建 transcript
  if (debugMode && rawActive) return
  runScreen = null
  pre.innerHTML = renderTranscript(pairs, showTime)
  if (stickToBottom) {
    pre.scrollTop = pre.scrollHeight
    toBottomBtn.style.display = "none"
  } else {
    toBottomBtn.style.display = pre.scrollHeight > pre.clientHeight ? "block" : "none"
  }
}

// ===== Run 增量处理 =====
function handleRun(msg: { data: string }): void {
  if (!msg.data || debugMode) return
  const pre = document.getElementById("term") as HTMLPreElement
  const toBottomBtn = document.getElementById("toBottom") as HTMLButtonElement
  let block = document.getElementById("runBlock") as HTMLDivElement | null
  if (!runScreen) {
    runScreen = new TermScreen(PTY_COLS)
    block = document.createElement("div")
    block.id = "runBlock"
    pre.appendChild(block)
  }
  runScreen.write(stripDone(msg.data))
  const html = runScreen.render().map((row) => '<div class="row"><span class="t"></span><span class="c">' + row + '</span></div>').join("")
  block!.innerHTML = html
  if (stickToBottom) {
    pre.scrollTop = pre.scrollHeight
    toBottomBtn.style.display = "none"
  } else {
    toBottomBtn.style.display = "block"
  }
}

/** Raw 连续流 TermScreen（debug 模式下模拟终端渲染） */
let rawScreen: TermScreen | null = null

// ===== Raw 连续流处理 =====
function handleRaw(msg: { data: string; reset?: boolean }): void {
  if (!debugMode) return
  const pre = document.getElementById("term") as HTMLPreElement
  const toBottomBtn = document.getElementById("toBottom") as HTMLButtonElement
  if (!rawActive) {
    rawActive = true
    pre.innerHTML = ""
    rawScreen = null
  }
  if (msg.reset) {
    rawScreen = new TermScreen(PTY_COLS)
    rawScreen.write(msg.data || "")
  } else if (msg.data) {
    if (!rawScreen) rawScreen = new TermScreen(PTY_COLS)
    rawScreen.write(msg.data)
  }
  if (rawScreen) {
    const rows = rawScreen.render().map((r) => '<div class="row"><span class="c">' + r + '</span></div>').join("")
    pre.innerHTML = rows
  }
  if (stickToBottom) {
    pre.scrollTop = pre.scrollHeight
    toBottomBtn.style.display = "none"
  } else {
    toBottomBtn.style.display = pre.scrollHeight > pre.clientHeight ? "block" : "none"
  }
}

// ===== 命令开始处理 =====
function handleCmdStart(msg: { command: string }): void {
  if (debugMode) return // 调试模式不单独渲染 cmd，echo 已在 raw 输出中
  if (!msg.command) return
  const pre = document.getElementById("term") as HTMLPreElement
  const toBottomBtn = document.getElementById("toBottom") as HTMLButtonElement
  // 清理旧 runBlock（若存在），避免残留
  const old = document.getElementById("runBlock")
  if (old) old.remove()
  runScreen = null
  // 插入命令行
  const showTime = (document.getElementById("showTime") as HTMLInputElement).checked
  const t = showTime ? fmtTime(Date.now()) : ""
  const row = document.createElement("div")
  row.className = "row cmdline"
  row.innerHTML = '<span class="t">' + t + '</span><span class="c">' + escHtml(msg.command) + '</span>'
  pre.appendChild(row)
  if (stickToBottom) {
    pre.scrollTop = pre.scrollHeight
    toBottomBtn.style.display = "none"
  }
}

// ===== 渲染函数 =====
function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

/** 可见完成标记剥离（展示给用户/模型的输出前调用） */
const DONE_RE = /<SSH_DONE:(-?\d+)>/g
function stripDone(s: string): string {
  return s.replace(DONE_RE, "")
}

function renderTranscript(pairs: TranscriptPair[], showTime: boolean): string {
  const out: string[] = []
  /** 当前命令的开始/结束时刻（供下一条输出行展示耗时与退出状态） */
  let pending: { ts?: number; endTs?: number } | null = null
  for (const p of pairs) {
    if (p.type === "sep") {
      out.push('<div class="sep"><hr></div>')
      continue
    }
    if (p.type === "cmd") {
      pending = { ts: p.ts, endTs: p.endTs }
      const t = p.ts ? fmtTime(p.ts) : ""
      out.push('<div class="row cmdline"><span class="t">' + t + '</span><span class="c">' + escHtml(p.text) + '</span></div>')
    } else if (p.type === "run") {
      runScreen = new TermScreen(PTY_COLS)
      runScreen.write(stripDone(p.text))
      const rows = runScreen.render().map((r) => '<div class="row"><span class="t"></span><span class="c">' + r + '</span></div>').join("")
      out.push('<div id="runBlock">' + rows + '</div>')
    } else {
      const parsed = parseOutput(p.text)
      const scr = new TermScreen(PTY_COLS)
      scr.write(parsed.text)
      const rows = scr.render()
      const meta = showTime ? resultMeta(pending, parsed.exitCode) : ""
      const rowOf = (t: string, c: string): string => '<div class="row"><span class="t">' + t + '</span><span class="c">' + c + '</span></div>'
      if (rows.length === 0) {
        // 无输出命令：占一个空行，让输出块可见（时间列展示耗时/退出状态）
        out.push(rowOf(meta, "&nbsp;"))
      } else {
        rows.forEach((r, i) => out.push(rowOf(i === rows.length - 1 ? meta : "", r)))
      }
      pending = null
    }
  }
  return out.join("")
}

/** 生成结果元信息 HTML（耗时 + 退出状态），展示在输出最后一行的时间列 */
function resultMeta(pending: { ts?: number; endTs?: number } | null, exitCode?: number): string {
  const parts: string[] = []
  if (pending && pending.ts && pending.endTs) parts.push("+" + ((pending.endTs - pending.ts) / 1000).toFixed(3) + "s")
  if (exitCode !== undefined) {
    const color = exitCode === 0 ? "#3fb950" : "#ff7b72"
    parts.push('<span style="color:' + color + '">' + (exitCode === 0 ? "✓" : "✗ " + exitCode) + '</span>')
  }
  return parts.join(" ")
}

function sessionLabel(s: SessionStatus): string {
  if (s.title && s.title.trim()) return s.title
  const t = s.terminals && s.terminals[0]
  if (t && t.host) return (t.user ? t.user + "@" : "") + t.host
  return s.sessionID.slice(0, 8) + "…"
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, "0")
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds())
}

function dropDeadTerminal(sid: string, name: string): void {
  const s = sessionsData.find((x) => x.sessionID === sid)
  if (s) {
    s.terminals = s.terminals.filter((t) => (t.name || "default") !== name)
    if (s.terminals.length === 0) sessionsData = sessionsData.filter((x) => x.sessionID !== sid)
  }
  const sel = document.getElementById("session") as HTMLSelectElement
  const prev = sel.value
  sel.innerHTML = ""
  for (const s2 of sessionsData) {
    const opt = document.createElement("option")
    opt.value = s2.sessionID
    opt.textContent = sessionLabel(s2) + "  (" + s2.terminals.length + " " + I18N.terminals + ")"
    sel.appendChild(opt)
  }
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev
  else sel.selectedIndex = sessionsData.length ? 0 : -1
  const prevTerminal = (document.getElementById("terminal") as HTMLSelectElement).value
  updateTerminalSelect(prevTerminal)
}

function onSessionChange(forceStick: boolean): void {
  if (forceStick) stickToBottom = true
  const prevName = (document.getElementById("terminal") as HTMLSelectElement).value
  updateTerminalSelect(prevName)
}

function onShowTimeChange(): void {
  const el = document.getElementById("showTime") as HTMLInputElement
  localStorage.setItem("showTime", el.checked ? "1" : "0")
  document.body.classList.toggle("show-time", el.checked)
}

function onDebugModeChange(): void {
  const el = document.getElementById("debugMode") as HTMLInputElement
  debugMode = el.checked
  localStorage.setItem("debugMode", el.checked ? "1" : "0")
  document.body.classList.toggle("debug", el.checked)
  // 立即重渲染：重新订阅当前终端，触发 snapshot 重推
  subSid = ""
  subName = ""
  subscribe()
}

function deleteTerminal(): void {
  const sid = (document.getElementById("session") as HTMLSelectElement).value
  const name = (document.getElementById("terminal") as HTMLSelectElement).value
  if (!name || !ws || ws.readyState !== WebSocket.OPEN) return
  const s = sessionsData.find((x) => x.sessionID === sid)
  const t = s?.terminals.find((t2) => (t2.name || "default") === name)
  if (!t || t.connected) return
  ws.send(JSON.stringify({ type: "deleteTerminal", sessionID: sid, name }))
  // 立即从本地状态移除，等下次 sessions 推送会同步
  if (s) {
    s.terminals = s.terminals.filter((t2) => (t2.name || "default") !== name)
    if (s.terminals.length === 0) sessionsData = sessionsData.filter((x) => x.sessionID !== sid)
  }
  // 切到第一个终端
  const prev = (document.getElementById("terminal") as HTMLSelectElement).value
  updateTerminalSelect(prev !== name ? prev : undefined)
}

function scrollToNewest(): void {
  const pre = document.getElementById("term") as HTMLPreElement
  const toBottomBtn = document.getElementById("toBottom") as HTMLButtonElement
  pre.scrollTop = pre.scrollHeight
  stickToBottom = true
  toBottomBtn.style.display = "none"
}

// ===== 初始化 =====
const showTimeEl = document.getElementById("showTime") as HTMLInputElement
showTimeEl.checked = localStorage.getItem("showTime") === "1"
document.body.classList.toggle("show-time", showTimeEl.checked)

const debugModeEl = document.getElementById("debugMode") as HTMLInputElement
debugMode = localStorage.getItem("debugMode") === "1"
debugModeEl.checked = debugMode
document.body.classList.toggle("debug", debugMode)

const termPre = document.getElementById("term") as HTMLPreElement
const toBottomBtn = document.getElementById("toBottom") as HTMLButtonElement
termPre.addEventListener("scroll", () => {
  if (termPre.scrollTop + termPre.clientHeight >= termPre.scrollHeight - 30) {
    stickToBottom = true
    toBottomBtn.style.display = "none"
  } else {
    stickToBottom = false
  }
})

Object.assign(window, {
  onSessionChange,
  onShowTimeChange,
  onDebugModeChange,
  deleteTerminal,
  scrollToNewest,
})

connectWs()