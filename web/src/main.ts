// 前端入口：TermScreen 终端模拟渲染 + transcript 轮询展示

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

interface SessionStatus {
  sessionID: string
  title?: string
  directory?: string
  terminals: TerminalInfo[]
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

interface TranscriptPair {
  type: "cmd" | "out" | "run"
  ts?: number
  text: string
}

interface GridCell {
  ch: string
  fg: string | null
  bg: string | null
  bold: boolean
}

const I18N: I18n = (window as unknown as { __I18N__: I18n }).__I18N__

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

  render(): { row: number; html: string }[] {
    const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    const out: { row: number; html: string }[] = []
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
      out.push({ row: ri, html })
    }
    return out
  }
}

interface Mark {
  row: number
  ts?: number
  run: boolean
}

function renderTranscript(pairs: TranscriptPair[], showTime: boolean): string {
  const screen = new TermScreen(120)
  const marks: Mark[] = []
  let lastEndNL = true
  for (const p of pairs) {
    if (p.type === "cmd") {
      marks.push({ row: screen.r, ts: p.ts, run: false })
      continue
    }
    if (p.type === "run") marks.push({ row: screen.r, run: true })
    if (!lastEndNL && !p.text.startsWith("\n")) screen.write("\n")
    screen.write(p.text)
    lastEndNL = p.text.endsWith("\n")
  }
  const rows = screen.render()
  const timeByRow = new Map<number, Mark>()
  for (const m of marks) {
    const hit = rows.find((r) => r.row >= m.row)
    if (hit && !timeByRow.has(hit.row)) timeByRow.set(hit.row, m)
  }
  return rows
    .map((r) => {
      const m = timeByRow.get(r.row)
      const t = m && !m.run && showTime && m.ts ? fmtTime(m.ts) : ""
      const label = m && m.run ? I18N.run : ""
      return '<div class="row"><span class="t">' + t + '</span><span class="c">' + label + r.html + '</span></div>'
    })
    .join("")
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

let sessionsData: SessionStatus[] = []
let stickToBottom = true
let lastSessionsKey = ""
let lastTranscript = ""
let pendingTop = 0

async function loadSessions(): Promise<void> {
  let data: { sessions: SessionStatus[] }
  try {
    const r = await fetch("/api/status")
    data = (await r.json()) as { sessions: SessionStatus[] }
  } catch {
    return
  }
  const newSessions = data.sessions || []
  const sel = document.getElementById("session") as HTMLSelectElement
  const key = newSessions.map((s) => s.sessionID + "|" + s.terminals.length).join(",")
  if (key === lastSessionsKey) return
  lastSessionsKey = key
  sessionsData = newSessions
  const prev = sel.value
  sel.innerHTML = ""
  for (const s of sessionsData) {
    const opt = document.createElement("option")
    opt.value = s.sessionID
    opt.textContent = sessionLabel(s) + "  (" + s.terminals.length + " " + I18N.terminals + ")"
    sel.appendChild(opt)
  }
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev
  else sel.selectedIndex = sessionsData.length ? 0 : -1
  onSessionChange(false)
}

function dropDeadTerminal(sid: string, name: string): void {
  const s = sessionsData.find((x) => x.sessionID === sid)
  if (s) {
    s.terminals = s.terminals.filter((t) => (t.name || "default") !== name)
    if (s.terminals.length === 0) sessionsData = sessionsData.filter((x) => x.sessionID !== sid)
  }
  lastSessionsKey = ""
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
  onSessionChange(false)
}

function onSessionChange(forceStick: boolean): void {
  lastTranscript = ""
  pendingTop = 0
  const sel = document.getElementById("session") as HTMLSelectElement
  const sid = sel.value
  const tsel = document.getElementById("terminal") as HTMLSelectElement
  const prev = tsel.value
  tsel.innerHTML = ""
  const s = sessionsData.find((x) => x.sessionID === sid)
  for (const t of (s ? s.terminals : [])) {
    const opt = document.createElement("option")
    opt.value = t.name || "default"
    opt.textContent = (t.name || "default") + (t.kind === "local" ? " [" + I18N.local + "]" : "") + "  " + (t.connected ? "●" : "○") + (t.busy ? " ⏳" : "")
    tsel.appendChild(opt)
  }
  if (prev && [...tsel.options].some((o) => o.value === prev)) tsel.value = prev
  else tsel.selectedIndex = tsel.options.length ? 0 : -1
  if (forceStick) stickToBottom = true
  loadTranscript(true)
}

async function loadTranscript(force = false): Promise<void> {
  const pre = document.getElementById("term") as HTMLPreElement
  const sel = document.getElementById("session") as HTMLSelectElement
  const tsel = document.getElementById("terminal") as HTMLSelectElement
  const toBottomBtn = document.getElementById("toBottom") as HTMLButtonElement
  const sid = sel.value
  const name = tsel.value
  if (!sid || !name) {
    pre.textContent = I18N.noSession
    return
  }
  if (pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30) stickToBottom = true
  const showTime = (document.getElementById("showTime") as HTMLInputElement).checked
  document.body.classList.toggle("show-time", showTime)
  let data: { pairs?: TranscriptPair[]; notFound?: boolean }
  try {
    const r = await fetch("/api/transcript?session=" + encodeURIComponent(sid) + "&name=" + encodeURIComponent(name))
    if (!r.ok) throw new Error("HTTP " + r.status)
    data = (await r.json()) as { pairs?: TranscriptPair[]; notFound?: boolean }
  } catch {
    pre.textContent = I18N.loadFailed
    return
  }
  const pairs = data.pairs || []
  if (data.notFound) {
    lastTranscript = ""
    pendingTop = 0
    pre.innerHTML = '<div class="row"><span class="t"></span><span class="c">' + I18N.sessionGone + '</span></div>'
    document.getElementById("meta").textContent = ""
    dropDeadTerminal(sid, name)
    return
  }
  const sig = JSON.stringify(pairs)
  const changed = sig !== lastTranscript
  // 内容无变化且非强制刷新：跳过重渲染，避免每 2s 轮询导致布局抖动
  if (!changed && !force) return
  lastTranscript = sig
  const prevHeight = pre.scrollHeight
  pre.innerHTML = renderTranscript(pairs, showTime)
  const cmdCount = pairs.filter((p) => p.type === "cmd").length
  document.getElementById("meta").textContent = sid + "/" + name + " · " + cmdCount + " " + I18N.commands + " · " + I18N.autoRefresh
  if (stickToBottom) {
    pre.scrollTop = pre.scrollHeight
    toBottomBtn.style.display = "none"
  } else if (pendingTop > 0) {
    toBottomBtn.style.display = "block"
  }
  if (changed && pre.scrollHeight > pre.clientHeight) {
    pendingTop = prevHeight
    if (stickToBottom) pendingTop = 0
  }
}

function onShowTimeChange(): void {
  const el = document.getElementById("showTime") as HTMLInputElement
  localStorage.setItem("showTime", el.checked ? "1" : "0")
  document.body.classList.toggle("show-time", el.checked)
  loadTranscript()
}

function scrollToNewest(): void {
  const pre = document.getElementById("term") as HTMLPreElement
  const toBottomBtn = document.getElementById("toBottom") as HTMLButtonElement
  pre.scrollTop = pendingTop > 0 ? pendingTop : pre.scrollHeight
  pendingTop = 0
  toBottomBtn.style.display = "none"
}

const showTimeEl = document.getElementById("showTime") as HTMLInputElement
showTimeEl.checked = localStorage.getItem("showTime") === "1"
document.body.classList.toggle("show-time", showTimeEl.checked)

const termPre = document.getElementById("term") as HTMLPreElement
const toBottomBtn = document.getElementById("toBottom") as HTMLButtonElement
termPre.addEventListener("scroll", () => {
  if (termPre.scrollTop + termPre.clientHeight >= termPre.scrollHeight - 30) {
    stickToBottom = true
    toBottomBtn.style.display = "none"
    pendingTop = 0
  } else {
    stickToBottom = false
  }
})

// 暴露给 HTML 内联 onchange/onclick 的全局函数
Object.assign(window, {
  onSessionChange,
  onShowTimeChange,
  scrollToNewest,
})

loadSessions()
setInterval(loadTranscript, 2000)
setInterval(loadSessions, 5000)
