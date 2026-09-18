// 前端入口：纯 WebSocket 驱动（无 HTTP 轮询/断线重连），raw 模式 xterm.js 渲染、transcript 用 TermScreen

import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"

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
  exitCode?: number
  text: string
}

/** 从原始终端输出中提取退出码和剥离标记后的文本 */
function parseOutput(raw: string): { text: string; exitCode?: number } {
  const m = raw.match(DONE_RE)
  if (m && m.length > 0) {
    const last = m[m.length - 1].match(/(-?\d+)>$/)
    const code = last ? parseInt(last[1], 10) : NaN
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
  private sr = 0 // 保存的光标行（ESC 7 / CSI s）
  private sc = 0 // 保存的光标列
  private altGrid: GridCell[][] | null = null // 备屏保存（CSI ?1049h/l）

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
        if (text[i + 1] === "7") { this.sr = this.r; this.sc = this.c; i += 2; continue }
        if (text[i + 1] === "8") { this.r = Math.min(this.sr, this.grid.length - 1); this.c = this.sc; i += 2; continue }
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
    else if (final === "s") { this.sr = this.r; this.sc = this.c }
    else if (final === "u") { this.r = Math.min(this.sr, this.grid.length - 1); this.c = this.sc }
    else if ((final === "h" || final === "l") && body.startsWith("?")) {
      const mode = va(body.slice(1).split(";")[0])
      if (mode === 1049) {
        if (final === "h") {
          this.altGrid = this.grid.map((row) => row.slice())
          this.sr = this.r; this.sc = this.c
          this.grid = []
          this.r = 0; this.c = 0
        } else if (this.altGrid) {
          this.grid = this.altGrid
          this.altGrid = null
          this.r = Math.min(this.sr, this.grid.length - 1); this.c = this.sc
        }
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
/** 当前活动输出块（diff 渲染用，固化后保留在 DOM，后续命令不再复用/删除） */
let curBlock: HTMLDivElement | null = null
let debugMode = false
/** 用户配置的 raw 意图（历史会话可用 history 重建 raw 流，无需依赖实时连接） */
let prefRaw = localStorage.getItem("debugMode") === "1"

/** 实际生效的 raw 模式：统一按用户意图（离线历史会话由 server 从 history 重建 raw 流） */
function effRaw(): boolean {
  return prefRaw
}

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
      case "meta": handleMeta(msg as unknown as { sessionID: string; name: string; commands: number }); break
      case "diff": handleDiff(msg as unknown as { sessionID: string; name: string; event: string; command?: string; data?: string; exitCode?: number; endTs?: number; ts?: number }); break
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
/** 清除全部会话：清空下拉/内容区/订阅/raw 模式，页面恢复到无终端状态 */
function clearAllTerminals(): void {
  const sel = document.getElementById("session") as HTMLSelectElement
  const tsel = document.getElementById("terminal") as HTMLSelectElement
  const termPre = document.getElementById("term") as HTMLPreElement
  sel.innerHTML = ""
  tsel.innerHTML = ""
  termPre.innerHTML = '<div class="row"><span class="c">' + (I18N.noSession || "") + '</span></div>'
  document.getElementById("meta").textContent = ""
  localPairs = []
  subSid = ""
  subName = ""
  prefRaw = false
  debugMode = false
  localStorage.removeItem("debugMode")
  const cb = document.getElementById("debugMode") as HTMLInputElement
  cb.checked = false
  hideRawUi()
  updateCmdBar()
}

function updateSessions(msg: { sessions: SessionStatus[] }): void {
  const newSessions = msg.sessions || []
  const sel = document.getElementById("session") as HTMLSelectElement
  sessionsData = newSessions
  // 会话已全部删除：清空界面，避免残留已删除会话的画面/订阅
  if (newSessions.length === 0) {
    clearAllTerminals()
    return
  }
  const key = newSessions.map((s) => s.sessionID + "|" + s.terminals.length).join(",")
  const prev = sel.value
  const prevTerminal = (document.getElementById("terminal") as HTMLSelectElement).value
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

/** 根据当前终端连接/忙状态更新输入框与快捷键按钮可用性 */
function updateCmdBar(): void {
  const disabled = !(sessionsData.find((x) => x.sessionID === (document.getElementById("session") as HTMLSelectElement).value)
    ?.terminals.find((t2) => (t2.name || "default") === (document.getElementById("terminal") as HTMLSelectElement).value)?.connected)
  const key = document.getElementById("cmdKey") as HTMLSpanElement
  key.classList.toggle("disabled", disabled)
  key.title = disabled ? "" : (I18N.sendCtrlC || "")
  // Raw 开关始终可用：在线走实时流，离线历史会话由 server 从 history 重建 raw 流
  const rawCb = document.getElementById("debugMode") as HTMLInputElement
  const rawToggle = document.getElementById("rawToggle")
  rawCb.disabled = false
  if (rawToggle) rawToggle.classList.remove("disabled")
  rawCb.checked = prefRaw
  debugMode = effRaw()
  if (debugMode) showRawUi()
  else hideRawUi()
}

function updateTerminalSelect(prevName?: string, forceSub = false): void {
  const sel = document.getElementById("session") as HTMLSelectElement
  const tsel = document.getElementById("terminal") as HTMLSelectElement
  const delBtn = document.getElementById("delTerm") as HTMLButtonElement
  const sid = sel.value
  const s = sessionsData.find((x) => x.sessionID === sid)
  const prevSel = tsel.value
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
  updateCmdBar()
  updateMetaFromSessions()
  // 重订阅时机：用户主动切换（change 事件）强制重订阅；sessions 状态推送才用值比较去重，
  // 避免 change 时 value 已更新导致 curSel===prevSel 永不触发订阅
  const curSel = tsel.value
  if (forceSub || curSel !== prevSel) {
    subSid = ""
    subName = ""
    subscribe()
  }
}

let subSid = ""
let subName = ""
/** 本地累积的命令/输出对（snapshot 基线 + diff 增量），transcript 渲染驱动 */
let localPairs: TranscriptPair[] = []

function subscribe(): void {
  const sid = (document.getElementById("session") as HTMLSelectElement).value
  const name = (document.getElementById("terminal") as HTMLSelectElement).value
  if (!sid || !name || !ws || ws.readyState !== WebSocket.OPEN) return
  if (sid === subSid && name === subName) return
  subSid = sid
  subName = name
  runScreen = null
  ws.send(JSON.stringify({ type: "subscribe", sessionID: sid, name, mode: debugMode ? "raw" : "transcript" }))
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
  updateMetaFromSessions(cmdCount)
  localPairs = pairs
  // raw 模式：画面由 xterm 渲染（raw 通道），snapshot 不重建 transcript
  if (debugMode) return
  runScreen = null
  curBlock = null
  pre.innerHTML = renderTranscript(pairs, showTime)
  updateScrollState(pre, toBottomBtn)
}

/** 从本地 sessionsData 更新顶部 meta（终端标识 + 类型 + 命令数） */
function updateMetaFromSessions(cmdCount?: number): void {
  const sid = (document.getElementById("session") as HTMLSelectElement).value
  const name = (document.getElementById("terminal") as HTMLSelectElement).value
  if (!sid) { document.getElementById("meta").textContent = ""; return }
  const s = sessionsData.find((x) => x.sessionID === sid)
  const t = s?.terminals.find((t2) => (t2.name || "default") === name)
  const typeInfo = t ? (t.host ? t.host + (t.port ? ":" + t.port : "") : (t.program || "")) : ""
  const typePart = typeInfo ? " [" + typeInfo + "]" : ""
  // cmdCount 未传时从本地累积的命令/输出对统计（diff 增量期间 sessions 推送不覆盖命令数）
  const count = cmdCount ?? localPairs.filter((p) => p.type === "cmd").length
  const countPart = " · " + count + " " + I18N.commands
  document.getElementById("meta").textContent = sid + "/" + name + typePart + countPart
}

/** 根据是否吸附底部更新 transcript 滚动：吸附时滚到底并隐藏按钮，否则按是否有溢出显示返回顶部按钮 */
function updateScrollState(pre: HTMLPreElement, toBottomBtn: HTMLButtonElement): void {
  if (stickToBottom) {
    pre.scrollTop = pre.scrollHeight
    toBottomBtn.style.display = "none"
  } else {
    toBottomBtn.style.display = pre.scrollHeight > pre.clientHeight ? "block" : "none"
  }
}

// ===== Diff 增量处理（transcript 模式唯一增量来源：cmd/out/done） =====
function handleDiff(msg: { sessionID: string; name: string; event: string; command?: string; data?: string; exitCode?: number; endTs?: number; ts?: number; final?: boolean }): void {
  if (debugMode) return // raw 模式画面由 raw 通道渲染，diff 忽略
  const pre = document.getElementById("term") as HTMLPreElement
  const toBottomBtn = document.getElementById("toBottom") as HTMLButtonElement
  const showTime = (document.getElementById("showTime") as HTMLInputElement).checked
  if (msg.event === "cmd") {
    if (!msg.command) return
    // 清理残留的未完成 runBlock（若上一条命令异常中断未收 done，会残留半截输出块）；
    // 已固化（收到过 done）的 runBlock 保留不动，避免后续 cmdStart 误删已完成的命令输出
    const old = curBlock as HTMLDivElement | null
    if (old && old.dataset.finalized !== "1") old.remove()
    curBlock = null
    runScreen = null
    // 插入命令行
    const t = showTime ? fmtTime(Date.now()) : ""
    const row = document.createElement("div")
    row.className = "row cmdline"
    row.innerHTML = '<span class="t">' + t + '</span><span class="c">' + escHtml(msg.command) + '</span>'
    pre.appendChild(row)
    // 本地累积：新命令对
    localPairs.push({ type: "cmd", ts: typeof msg.ts === "number" ? msg.ts : Date.now(), text: msg.command })
  } else if (msg.event === "out") {
    if (!msg.data) return
    // 当前命令输出块：以 curBlock 是否仍挂在 DOM 为准（runScreen 可能与 block 解耦——
    // snapshot 渲染或 final 重建后会置 runScreen，curBlock 却为 null，若以 runScreen 判空会漏建 block 崩溃）
    let block = curBlock as HTMLDivElement | null
    if (!block || block.parentNode !== pre) {
      block = document.createElement("div")
      block.className = "runBlock"
      pre.appendChild(block)
      curBlock = block
    }
    if (msg.final) {
      // 命令完成时 server 下推的处理后完整输出：丢弃 diff 增量累积（动画帧等），重建本命令输出块
      runScreen = new TermScreen(PTY_COLS)
      // 本地累积：用处理后结果替换此前累积的原始增量（避免本地/快照不一致）
      const last = localPairs[localPairs.length - 1]
      if (last && last.type === "out") last.text = msg.data
      else localPairs.push({ type: "out", text: msg.data })
    } else {
      if (!runScreen) runScreen = new TermScreen(PTY_COLS)
      // 本地累积：追加到当前输出块（对命令/输出对的 out 累积）
      const last = localPairs[localPairs.length - 1]
      if (last && last.type === "out") last.text += msg.data
      else localPairs.push({ type: "out", text: msg.data })
    }
    runScreen.write(stripDone(msg.data))
    const html = runScreen.render().map((row) => '<div class="row"><span class="t"></span><span class="c">' + row + '</span></div>').join("")
    block.innerHTML = html
    // REPL 交互等持续 out 场景同样需跟随输出滚动（此前仅有 done 时滚动，输出中途会停住）
    updateScrollState(pre, toBottomBtn)
  } else if (msg.event === "done") {
    // 当前输出块固化：补 endTs + exitCode，并打完成标记（后续 cmdStart 不再删除）
    const cmdPairs = [...localPairs].reverse().find((p) => p.type === "cmd")
    let b = curBlock as HTMLDivElement | null
    if (!b || b.parentNode !== pre) {
      // 无输出命令：创建占位块，让退出状态可见（与 snapshot 渲染的空行行为一致）
      if (cmdPairs) {
        b = document.createElement("div")
        b.className = "runBlock"
        pre.appendChild(b)
        curBlock = b
      }
    }
    if (b && b.parentNode === pre) {
      // 为最后一行的时列补耗时与退出状态
      const meta = showTime ? resultMeta({ ts: cmdPairs?.ts, endTs: msg.endTs }, msg.exitCode) : ""
      if (b.childElementCount === 0 && cmdPairs) {
        const row = document.createElement("div")
        row.className = "row"
        row.innerHTML = '<span class="t">' + meta + '</span><span class="c">&nbsp;</span>'
        b.appendChild(row)
      } else {
        const lastRow = b.lastElementChild as HTMLDivElement | null
        if (lastRow) {
          const c = lastRow.querySelector(".t")
          if (c) c.innerHTML = meta
        }
      }
    }
    const out = localPairs[localPairs.length - 1]
    if (out && out.type === "out") {
      out.endTs = msg.endTs
      out.exitCode = msg.exitCode
    }
    if (b && b.parentNode === pre) b.dataset.finalized = "1"
    updateScrollState(pre, toBottomBtn)
  }
}

// ===== 轻量 meta 处理（raw 模式：只有命令计数，无 pairs 全量） =====
function handleMeta(msg: { sessionID: string; name: string; commands: number }): void {
  if (typeof msg.commands === "number") updateMetaFromSessions(msg.commands)
}

// ===== Raw 连续流处理（xterm.js 忠实渲染，天然支持跨行光标定位/交互程序） =====
let xtermInst: Terminal | null = null
let xtResizeObserver: ResizeObserver | null = null
let stickToBottomRaw = true

/** 懒创建/挂载 xterm 实例到容器（容器缺失时动态补建，兼容旧模板缓存） */
function ensureXterm(): Terminal {
  if (xtermInst) return xtermInst
  let el = document.getElementById("xt") as HTMLDivElement | null
  if (!el) {
    el = document.createElement("div")
    el.id = "xt"
    const term = document.getElementById("term") as HTMLPreElement | null
    ;(term?.parentNode ?? document.body).insertBefore(el, term?.nextSibling ?? null)
  }
  const t = new Terminal({
    cols: PTY_COLS,
    rows: 30,
    scrollback: 2000,
    fontFamily: '"CaskaydiaCove Nerd Font Mono", "Cascadia Code", "Fira Code", "JetBrains Mono", "Noto Sans Mono", "Hack", Consolas, "Courier New", monospace',
    fontSize: 13,
    theme: {
      background: "#0d1117",
      foreground: "#c9d1d9",
      cursor: "#58a6ff",
      selectionBackground: "#30363d",
      black: "#010409",
      red: "#ff7b72",
      green: "#3fb950",
      yellow: "#d29922",
      blue: "#58a6ff",
      magenta: "#bc8cff",
      cyan: "#39c5cf",
      white: "#c9d1d9",
      brightBlack: "#666666",
      brightRed: "#ffa198",
      brightGreen: "#56d364",
      brightYellow: "#e3b341",
      brightBlue: "#79c0ff",
      brightMagenta: "#d2a8ff",
      brightCyan: "#56d4dd",
      brightWhite: "#f0f6fc",
    },
  })
  const fitAddon = new FitAddon()
  t.loadAddon(fitAddon)
  t.open(el)
  // 高度自适应：容器尺寸变化时按行高精确计算行数（列宽保持 PTY_COLS，与 server 侧保持一致）
  const fitRows = (): void => {
    const dim = fitAddon.proposeDimensions()
    if (dim && dim.rows !== t.rows) t.resize(PTY_COLS, dim.rows)
  }
  // open 后等渲染就绪再精确测量（行高未就绪时 proposeDimensions 会返回 NaN）
  setTimeout(fitRows, 50)
  if (typeof ResizeObserver !== "undefined") {
    xtResizeObserver = new ResizeObserver(() => {
      fitRows()
    })
    xtResizeObserver.observe(el)
  }
  // 滚动监听：贴底由 raw 流刷新时维持，用户上滚后不强制拉回
  t.onScroll(() => {
    const vp = t.buffer.active.viewportY
    stickToBottomRaw = vp >= t.buffer.active.baseY
  })
  xtermInst = t
  return t
}

/** 切换到 raw 展示（隐藏 transcript pre，显示 xterm 容器），并及时滚动到底 */
function showRawUi(): void {
  document.body.classList.add("debug")
  const t = ensureXterm()
  const toBottomBtn = document.getElementById("toBottom") as HTMLButtonElement
  toBottomBtn.style.display = "none"
  if (stickToBottomRaw) t.scrollToBottom()
}

/** 离开 raw 展示（恢复 transcript pre） */
function hideRawUi(): void {
  document.body.classList.remove("debug")
  if (xtResizeObserver) {
    xtResizeObserver.disconnect()
    xtResizeObserver = null
  }
  if (xtermInst) {
    xtermInst.dispose()
    xtermInst = null
  }
}

function handleRaw(msg: { data: string; reset?: boolean }): void {
  if (!debugMode) return
  const t = ensureXterm()
  if (msg.reset) {
    // 全量基线：先清空再写入（xterm reset 恢复初始化状态位，避免残留的 DECSET 模式污染后续输出）
    t.reset()
    t.write(msg.data || "")
  } else if (msg.data) {
    t.write(msg.data)
  }
  if (stickToBottomRaw) t.scrollToBottom()
}

// ===== 渲染函数 =====
function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

/** 可见完成标记剥离（含序号式 <SSH_DONE:seq:code>，退出码在末尾；展示给用户/模型的输出前调用） */
const DONE_RE = /<SSH_DONE:(?:\d+:)?(-?\d+)>/g
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
      const scr = new TermScreen(PTY_COLS)
      scr.write(stripDone(p.text))
      const rows = scr.render().map((r) => '<div class="row"><span class="t"></span><span class="c">' + r + '</span></div>').join("")
      out.push('<div class="runBlock">' + rows + '</div>')
    } else {
      const parsed = parseOutput(p.text)
      const scr = new TermScreen(PTY_COLS)
      scr.write(parsed.text)
      const rows = scr.render()
      const meta = showTime ? resultMeta(pending, parsed.exitCode ?? p.exitCode) : ""
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
  // 用户主动切换会话/终端：强制重订阅（change 时 value 已更新，不能靠值比较判断变化）
  updateTerminalSelect(prevName, true)
}

function onShowTimeChange(): void {
  const el = document.getElementById("showTime") as HTMLInputElement
  localStorage.setItem("showTime", el.checked ? "1" : "0")
  document.body.classList.toggle("show-time", el.checked)
}

function onDebugModeChange(): void {
  const el = document.getElementById("debugMode") as HTMLInputElement
  prefRaw = el.checked
  localStorage.setItem("debugMode", el.checked ? "1" : "0")
  const mode = effRaw()
  debugMode = mode
  if (mode) showRawUi()
  else hideRawUi()
  // 只切换输出模式，不重新订阅（避免重发 snapshot / pairs 全量）
  if (ws && ws.readyState === WebSocket.OPEN && subSid && subName) {
    ws.send(JSON.stringify({ type: "setMode", mode: mode ? "raw" : "transcript" }))
  }
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
  // 删光的最后一个会话：立即清空界面（server pushSessions 会再次触发 clearAllTerminals，幂等）
  if (sessionsData.length === 0) {
    clearAllTerminals()
    return
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
if (debugMode) showRawUi()
else hideRawUi()

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

// ===== 底部命令输入 =====
const cmdHistory: string[] = []
let cmdHistIdx = -1
let tabMatchIdx = -1
let tabPrefix = ""

const cmdInput = document.getElementById("cmdInput") as HTMLTextAreaElement
cmdInput.placeholder = I18N.cmdPlaceholder || ""
cmdInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Tab") {
    ev.preventDefault()
    const val = cmdInput.value.trim()
    if (!val) return
    if (tabPrefix !== val) { tabMatchIdx = -1; tabPrefix = val }
    const matches = cmdHistory.filter((c) => c.startsWith(tabPrefix))
    if (matches.length === 0) return
    tabMatchIdx = (tabMatchIdx + 1) % matches.length
    cmdInput.value = matches[tabMatchIdx]
    autoGrowCmdInput()
    return
  }
  tabPrefix = ""
  if (ev.key === "ArrowUp") {
    ev.preventDefault()
    if (cmdHistIdx > 0) { cmdHistIdx--; cmdInput.value = cmdHistory[cmdHistIdx]; autoGrowCmdInput() }
    return
  }
  if (ev.key === "ArrowDown") {
    ev.preventDefault()
    if (cmdHistIdx < cmdHistory.length - 1) { cmdHistIdx++; cmdInput.value = cmdHistory[cmdHistIdx]; autoGrowCmdInput() }
    else { cmdHistIdx = cmdHistory.length; cmdInput.value = ""; autoGrowCmdInput() }
    return
  }
  if (ev.key !== "Enter") return
  ev.preventDefault()
  if (ev.shiftKey) {
    // Shift+Enter = 输入框内插入换行（编辑多行命令），不发送；纯回车 = 提交命令
    const start = cmdInput.selectionStart ?? cmdInput.value.length
    const end = cmdInput.selectionEnd ?? cmdInput.value.length
    cmdInput.value = cmdInput.value.slice(0, start) + "\n" + cmdInput.value.slice(end)
    cmdInput.selectionStart = cmdInput.selectionEnd = start + 1
    autoGrowCmdInput()
    return
  }
  const sid = (document.getElementById("session") as HTMLSelectElement).value
  const name = (document.getElementById("terminal") as HTMLSelectElement).value
  if (!sid || !ws || ws.readyState !== WebSocket.OPEN) return
  const text = cmdInput.value
  cmdInput.value = ""
  autoGrowCmdInput()
  if (!text.trim()) return
  if (subSid !== sid || subName !== name) {
    subSid = sid
    subName = name
    ws.send(JSON.stringify({ type: "subscribe", sessionID: sid, name }))
  }
  // 回车 = 提交命令：busy 判定在 agent 端（<阈值视为连续命令排队，否则按交互输入原样 send）
  const command = text.trim()
  cmdHistory.push(command)
  cmdHistIdx = cmdHistory.length
  ws.send(JSON.stringify({ type: "exec", sessionID: sid, name, command }))
  stickToBottom = true
})

function autoGrowCmdInput(): void {
  cmdInput.style.height = "auto"
  cmdInput.style.height = Math.min(cmdInput.scrollHeight, 120) + "px"
}
cmdInput.addEventListener("input", autoGrowCmdInput)

// 快捷键捕获区：点击激活后按键即发送到终端（可连续输入），再点击取消
const cmdKey = document.getElementById("cmdKey") as HTMLSpanElement
const CMD_KEY_RESET = I18N.sendCtrlC || "Ctrl-C"
let capActive = false
/** 点击激活捕获状态：点一下激活（可连续输入多个键），再点一下取消 */
let capLocked = false
cmdKey.textContent = CMD_KEY_RESET
function sendKeystroke(ev: KeyboardEvent): void {
  if (!capActive) return
  const sid = (document.getElementById("session") as HTMLSelectElement).value
  const name = (document.getElementById("terminal") as HTMLSelectElement).value
  if (!sid || !ws || ws.readyState !== WebSocket.OPEN) return
  let text: string
  let label: string
  if (ev.ctrlKey && ev.key !== "Control") {
    const code = ev.key.toLowerCase().charCodeAt(0) - 96
    if (code >= 1 && code <= 26) { text = "\\x" + code.toString(16).padStart(2, "0"); label = "Ctrl-" + ev.key.toUpperCase() }
    else { text = ""; label = "" }
  } else if (ev.key === "Enter") { text = "\\r"; label = "↵" }
  else if (ev.key === "Escape") { text = "\\x1b"; label = "Esc" }
  else if (ev.key === "Tab") { text = "\\t"; label = "Tab" }
  else if (ev.key === "Backspace") { text = "\\x7f"; label = "⌫" }
  else if (ev.key === " " || ev.key === "Space") { text = " "; label = "Space" }
  else if (ev.key === "ArrowUp") { text = "\\x1b[A"; label = "↑" }
  else if (ev.key === "ArrowDown") { text = "\\x1b[B"; label = "↓" }
  else if (ev.key === "ArrowRight") { text = "\\x1b[C"; label = "→" }
  else if (ev.key === "ArrowLeft") { text = "\\x1b[D"; label = "←" }
  else if (ev.key === "Home") { text = "\\x1b[H"; label = "Home" }
  else if (ev.key === "End") { text = "\\x1b[F"; label = "End" }
  else if (ev.key === "PageUp") { text = "\\x1b[5~"; label = "PgUp" }
  else if (ev.key === "PageDown") { text = "\\x1b[6~"; label = "PgDn" }
  else if (/^F[1-4]$/.test(ev.key)) { text = "\\x1bO" + "PQRS"[Number(ev.key.slice(1)) - 1]; label = ev.key }
  else if (/^F([5-9]|1[0-2])$/.test(ev.key)) {
    const n = Number(ev.key.slice(1))
    const tilde = { 5: 15, 6: 17, 7: 18, 8: 19, 9: 20, 10: 21, 11: 23, 12: 24 }[n]
    text = "\\x1b[" + tilde + "~"; label = ev.key
  }
  else if (ev.key.length === 1) { text = ev.key; label = ev.key }
  else return
  if (text) ws.send(JSON.stringify({ type: "send", sessionID: sid, name, text }))
  cmdKey.textContent = label || CMD_KEY_RESET
  setTimeout(() => { if (!capActive) cmdKey.textContent = CMD_KEY_RESET }, 1500)
}
cmdKey.addEventListener("click", () => {
  const sid = (document.getElementById("session") as HTMLSelectElement).value
  if (!sid) return
  // 点击切换捕获：点一下激活（可连续输入多个键），再点一下取消
  capLocked = !capLocked
  if (capLocked) {
    capActive = true
    cmdKey.classList.add("capture")
    cmdKey.textContent = "..."
    document.addEventListener("keyup", sendKeystroke)
    // 激活快捷键捕获时退出输入框聚焦：按键经 document 捕获发送到终端，不再误输入到命令框
    cmdInput.blur()
  } else {
    capActive = false
    cmdKey.classList.remove("capture")
    document.removeEventListener("keyup", sendKeystroke)
    cmdKey.textContent = CMD_KEY_RESET
  }
})
// 输入框聚焦 → 自动取消快捷键捕获（回到正常命令输入，避免按键同时被输入框与快捷键消费）
cmdInput.addEventListener("focus", () => {
  if (!capActive) return
  capLocked = false
  capActive = false
  cmdKey.classList.remove("capture")
  document.removeEventListener("keyup", sendKeystroke)
  cmdKey.textContent = CMD_KEY_RESET
})

Object.assign(window, {
  onSessionChange,
  onShowTimeChange,
  onDebugModeChange,
  deleteTerminal,
  scrollToNewest,
})

connectWs()