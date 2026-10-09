// 前端入口：纯 WebSocket 驱动（无 HTTP 轮询/断线重连），raw 模式 xterm.js 渲染、transcript 用 HeadlessScreen

import { Terminal } from "@xterm/xterm"
import { Terminal as HeadlessTerminal } from "@xterm/headless"
import type { IBufferCell, Terminal as HeadlessTerminalType } from "@xterm/headless"

interface I18n {
  commands: string
  sessionGone: string
  noSession: string
  terminals: string
  local: string
  cmdPlaceholder: string
  sendCtrlC: string
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

const I18N: I18n = (window as unknown as { __I18N__: I18n }).__I18N__
const PTY_COLS: number = (window as unknown as { __PTY_COLS__: number }).__PTY_COLS__ || 120
const PTY_ROWS: number = (window as unknown as { __PTY_ROWS__: number }).__PTY_ROWS__ || 40

const ANSI_BASE = ["#010101", "#de382b", "#39b54a", "#ffc005", "#006fb8", "#762671", "#2cb3e9", "#c9d1d9"]
const ANSI_BRIGHT = ["#666666", "#ff7b72", "#3fb950", "#d29922", "#58a6ff", "#bc8cff", "#39c5cf", "#f0f6fc"]

/** headless 模拟保留的 scrollback 行数（与模型侧 TERM_SCROLLBACK_LINES 一致） */
const SCROLLBACK_LINES = 2000

/** headless 写入回调等待上限（毫秒）：超时按已解析内容渲染，避免极端情况下界面卡死 */
const WRITE_TIMEOUT_MS = 10_000

/** 256 色中 16..231 色立方每通道取值 */
const COLOR_CUBE_STEPS = [0, 95, 135, 175, 215, 255]

/**
 * 8 位分量转 #rrggbb
 * @param r 红分量 0-255
 * @param g 绿分量 0-255
 * @param b 蓝分量 0-255
 * @returns #rrggbb
 */
function rgbHex(r: number, g: number, b: number): string {
  const h = (n: number): string => n.toString(16).padStart(2, "0")
  return "#" + h(r) + h(g) + h(b)
}

/**
 * xterm 调色板索引转 CSS 颜色：0-7 基本色、8-15 亮色（复用既有调色板常量），
 * 16-231 为 6×6×6 色立方，232-255 为灰度阶；越界返回 null（按默认色处理）
 * @param index 调色板索引
 * @returns #rrggbb 或 null
 */
function paletteColor(index: number): string | null {
  if (index >= 0 && index < 8) return ANSI_BASE[index]
  if (index >= 8 && index < 16) return ANSI_BRIGHT[index - 8]
  if (index >= 16 && index < 232) {
    const n = index - 16
    return rgbHex(COLOR_CUBE_STEPS[Math.floor(n / 36)], COLOR_CUBE_STEPS[Math.floor((n % 36) / 6)], COLOR_CUBE_STEPS[n % 6])
  }
  if (index >= 232 && index < 256) {
    const gray = 8 + (index - 232) * 10
    return rgbHex(gray, gray, gray)
  }
  return null
}

/**
 * 取单元格前景色
 * @param cell headless buffer 单元格
 * @returns #rrggbb；默认色返回 null（表示不设 style）
 */
function cellFg(cell: IBufferCell): string | null {
  if (cell.isFgDefault()) return null
  const c = cell.getFgColor()
  return cell.isFgPalette() ? paletteColor(c) : rgbHex((c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff)
}

/**
 * 取单元格背景色
 * @param cell headless buffer 单元格
 * @returns #rrggbb；默认色返回 null（表示不设 style）
 */
function cellBg(cell: IBufferCell): string | null {
  if (cell.isBgDefault()) return null
  const c = cell.getBgColor()
  return cell.isBgPalette() ? paletteColor(c) : rgbHex((c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff)
}

/**
 * 浏览器端屏幕模拟：基于 @xterm/headless 复刻真实终端语义（光标/清行/覆盖/SGR/备屏/scrollback）。
 * write 串行排队保证顺序与最终一致；render 读取 buffer.active 逐 cell 生成带样式的 HTML 行。
 */
class HeadlessScreen {
  private term: HeadlessTerminalType
  /** 写入串行队列：上一段写入完成后再写下一段 */
  private queue: Promise<void> = Promise.resolve()
  /** 是否已释放（释放后写入与渲染均为空操作） */
  private disposed = false

  /**
   * @param cols 终端列数（固定 PTY_COLS）
   */
  constructor(cols: number) {
    this.term = new HeadlessTerminal({
      cols,
      rows: PTY_ROWS,
      scrollback: SCROLLBACK_LINES,
      allowProposedApi: true,
    })
  }

  /**
   * 串行写入一段原始输出
   * @param text 原始输出（含 ANSI）
   * @returns Promise：本段解析落屏后兑现
   */
  write(text: string): Promise<void> {
    this.queue = this.queue.then(() => this.writeOnce(text))
    return this.queue
  }

  /**
   * 单次写入并等待 write 回调
   * @param text 原始输出（含 ANSI）
   * @returns Promise：回调触发或超时后兑现（已释放则立即兑现）
   */
  private writeOnce(text: string): Promise<void> {
    if (this.disposed) return Promise.resolve()
    return new Promise<void>((resolve) => {
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      const timer = setTimeout(done, WRITE_TIMEOUT_MS)
      this.term.write(text, () => {
        clearTimeout(timer)
        done()
      })
    })
  }

  /**
   * 渲染当前屏幕（含 scrollback）为 HTML 行数组：仅返回非空行，行尾去尾空白，
   * 逐 cell 取字符/颜色/粗体并合并相邻同一样式
   * @returns HTML 行字符串数组（内容已转义）
   */
  render(): string[] {
    if (this.disposed) return []
    const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    const buf = this.term.buffer.active
    const out: string[] = []
    for (let ri = 0; ri < buf.length; ri++) {
      const line = buf.getLine(ri)
      if (!line) continue
      // 行尾去尾空白：定位最后一个非空单元格
      let last = line.length
      while (last > 0) {
        const cell = line.getCell(last - 1)
        const ch = cell?.getChars() ?? ""
        if (ch !== "" && ch !== " ") break
        last--
      }
      if (last === 0) continue
      let html = ""
      let cur: string | null = null
      for (let ci = 0; ci < last; ci++) {
        const cell = line.getCell(ci)
        if (!cell) continue
        // 宽字符续格（宽度 0）跳过，避免重复输出
        if (cell.getWidth() === 0) continue
        const style: string[] = []
        if (cell.isBold()) style.push("font-weight:bold")
        const fg = cellFg(cell)
        if (fg) style.push("color:" + fg)
        const bg = cellBg(cell)
        if (bg) style.push("background-color:" + bg)
        const key = style.join(";")
        if (key !== cur) {
          if (cur) html += "</span>"
          cur = key
          if (key) html += '<span style="' + key + '">'
        }
        html += esc(cell.getChars() || " ")
      }
      if (cur) html += "</span>"
      out.push(html)
    }
    return out
  }

  /** 释放底层 headless 终端资源 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.term.dispose()
  }
}

// ===== 全局状态 =====
let ws: WebSocket | null = null
let sessionsData: SessionStatus[] = []
let stickToBottom = true
let runScreen: HeadlessScreen | null = null
/** 当前活动输出块（diff 渲染用，固化后保留在 DOM，后续命令不再复用/删除） */
let curBlock: HTMLDivElement | null = null
let debugMode = false
/** 用户配置的 raw 意图（历史会话可用 history 重建 raw 流，无需依赖实时连接） */
let prefRaw = localStorage.getItem("debugMode") === "1"

/** 实际生效的 raw 模式：统一按用户意图（离线历史会话由 server 从 history 重建 raw 流） */
function effRaw(): boolean {
  return prefRaw
}

/** 释放并清空当前命令的增量屏幕（切换命令/会话/重建时调用，避免 headless 终端泄漏） */
function resetRunScreen(): void {
  if (runScreen) runScreen.dispose()
  runScreen = null
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
  resetRunScreen()
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
  resetRunScreen()
  ws.send(JSON.stringify({ type: "subscribe", sessionID: sid, name, mode: debugMode ? "raw" : "transcript" }))
}

// ===== Snapshot 处理 =====
async function handleSnapshot(msg: { sessionID: string; name: string; pairs: TranscriptPair[]; notFound?: boolean }): Promise<void> {
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
  resetRunScreen()
  curBlock = null
  const html = await renderTranscript(pairs, showTime)
  // 渲染期间可能已切换会话/终端：丢弃过期快照，避免旧内容覆盖新画面
  if (msg.sessionID !== subSid || msg.name !== subName) return
  pre.innerHTML = html
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
    toBottomBtn.style.display = pre.scrollHeight > pre.clientHeight ? "inline-block" : "none"
  }
}

// ===== Diff 增量处理（transcript 模式唯一增量来源：cmd/out/done） =====
async function handleDiff(msg: { sessionID: string; name: string; event: string; command?: string; data?: string; exitCode?: number; endTs?: number; ts?: number; final?: boolean }): Promise<void> {
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
    resetRunScreen()
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
      resetRunScreen()
      runScreen = new HeadlessScreen(PTY_COLS)
      // 本地累积：用处理后结果替换此前累积的原始增量（避免本地/快照不一致）
      const last = localPairs[localPairs.length - 1]
      if (last && last.type === "out") last.text = msg.data
      else localPairs.push({ type: "out", text: msg.data })
    } else {
      if (!runScreen) runScreen = new HeadlessScreen(PTY_COLS)
      // 本地累积：追加到当前输出块（对命令/输出对的 out 累积）
      const last = localPairs[localPairs.length - 1]
      if (last && last.type === "out") last.text += msg.data
      else localPairs.push({ type: "out", text: msg.data })
    }
    // 捕获当前屏幕引用：await 期间若收到 cmd/新命令会 resetRunScreen，此时放弃本次渲染
    const scr = runScreen
    if (!scr) return
    await scr.write(stripDone(msg.data))
    if (runScreen !== scr) return
    // 重建整块时保留行尾状态列：done 处理器可能已在 write 挂起期间写入 meta（红 ✗ 一闪而过的竞态），
    // 此刻 localPairs 末尾的 out 对已由 done 补上 endTs/exitCode，据此重放让 meta 在重建后仍在
    const lastPair = localPairs[localPairs.length - 1]
    const lastCmd = [...localPairs].reverse().find((p) => p.type === "cmd")
    const meta = showTime && lastPair?.type === "out" && (lastPair.endTs !== undefined || lastPair.exitCode !== undefined)
      ? resultMeta({ ts: lastCmd?.ts, endTs: lastPair.endTs }, lastPair.exitCode)
      : ""
    const rows = scr.render()
    const html = rows
      .map((row, i) => '<div class="row"><span class="t">' + (i === rows.length - 1 ? meta : "") + '</span><span class="c">' + row + '</span></div>')
      .join("")
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
let stickToBottomRaw = true
/** 容器比终端矮时是否贴底（用户上滚后不强制拉回） */
let stickToBottomBox = true
/** 窗口尺寸变化时重算贴底（raw 展示期间注册，隐藏时移除） */
let boxResizeHandler: (() => void) | null = null

/** 终端固定 PTY_ROWS 行，窗口过矮时容器滚动并贴底，保证命令行/光标可见 */
function stickBoxToBottom(): void {
  const el = document.getElementById("xt")
  if (!el || !stickToBottomBox) return
  if (el.scrollHeight > el.clientHeight) el.scrollTop = el.scrollHeight
}

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
    rows: PTY_ROWS,
    scrollback: SCROLLBACK_LINES,
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
  t.open(el)
  // 容器滚动监听：窗口过矮时保持贴底，用户上滚后不强制拉回
  el.addEventListener("scroll", () => {
    stickToBottomBox = el.scrollTop + el.clientHeight >= el.scrollHeight - 2
  })
  boxResizeHandler = () => {
    stickToBottomBox = true
    stickBoxToBottom()
    if (stickToBottomRaw) t.scrollToBottom()
  }
  window.addEventListener("resize", boxResizeHandler)
  // 终端滚动监听：贴底由 raw 流刷新时维持，用户上滚后不强制拉回
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
  stickBoxToBottom()
}

/** 离开 raw 展示（恢复 transcript pre） */
function hideRawUi(): void {
  document.body.classList.remove("debug")
  if (boxResizeHandler) {
    window.removeEventListener("resize", boxResizeHandler)
    boxResizeHandler = null
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
  stickBoxToBottom()
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

async function renderTranscript(pairs: TranscriptPair[], showTime: boolean): Promise<string> {
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
      const scr = new HeadlessScreen(PTY_COLS)
      await scr.write(stripDone(p.text))
      const rows = scr.render().map((r) => '<div class="row"><span class="t"></span><span class="c">' + r + '</span></div>').join("")
      scr.dispose()
      out.push('<div class="runBlock">' + rows + '</div>')
    } else {
      const parsed = parseOutput(p.text)
      const scr = new HeadlessScreen(PTY_COLS)
      await scr.write(parsed.text)
      const rows = scr.render()
      scr.dispose()
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