// 前端入口：纯 WebSocket 驱动（无 HTTP 轮询/断线重连），raw 模式 xterm.js 渲染、transcript 用 HeadlessScreen

import { Terminal } from "@xterm/xterm"
import { Terminal as HeadlessTerminal } from "@xterm/headless"
import type { IBufferCell, Terminal as HeadlessTerminalType } from "@xterm/headless"

import { mapKeystroke } from "./keys.js"

interface I18n {
  commands: string
  sessionGone: string
  noSession: string
  terminals: string
  /** 传输任务面板标题/计数单位 */
  transfers: string
  /** 当前会话无传输任务时的空态文案 */
  transfersEmpty: string
  /** 传输方向 */
  transferUpload: string
  transferDownload: string
  /** 传输状态 */
  transferRunning: string
  transferDone: string
  transferFailed: string
  local: string
  cmdPlaceholder: string
  /** 直接输入入口标签/提示 */
  directInput: string
  /** 直接输入已启用（指示器文案） */
  inputOn: string
  /** 直接输入已关闭（指示器文案） */
  inputOff: string
  /** 页面 WS 断开、输入无法送达 */
  inputDisconnected: string
  /** 当前终端未连接 */
  inputOffline: string
  /** 不可删除的兜底提示（后端未给原因时使用） */
  deleteBlocked: string
  /** 删除操作失败的兜底提示 */
  deleteFailed: string
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
  /** 该终端当前是否允许删除（后端 deleteEligibility 判定） */
  canDelete?: boolean
  /** 不可删除时的可读原因（后端本地化文案） */
  deleteReason?: string
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

/**
 * 传输任务元数据（只读复制自 src/transfer-events.ts 的 TransferTask）。
 * 不跨目录运行时 import：Web 产物必须独立打包，旧 server 与新 app.js 混用时也不能因模块缺失崩溃。
 */
interface TransferTask {
  id: string
  sessionID: string
  name: string
  direction: "upload" | "download"
  localPath: string
  remotePath: string
  state: "running" | "done" | "failed"
  bytes: number
  total: number
  startedAt: number
  endedAt?: number
  errorCode?: string
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

/**
 * 注入文案缺失时的内置兜底，按页面语言（<html lang>）选择。
 * 常驻 server 进程与磁盘 app.js 版本可能错配（旧进程注入的 __I18N__ 缺少新增键），
 * 此时必须以对应语言的兜底文案渲染，绝不出现 undefined/空标签，也不把中文用户显示成英文。
 */
const I18N_FALLBACK: Record<"en" | "zh", I18n> = {
  en: {
    commands: "commands",
    sessionGone: "Session missing or disconnected",
    noSession: "No terminal. Use term_cli connect (SSH) or term_cli local first.",
    terminals: "terminals",
    transfers: "Transfers",
    transfersEmpty: "No transfers in this session.",
    transferUpload: "Upload",
    transferDownload: "Download",
    transferRunning: "running",
    transferDone: "done",
    transferFailed: "failed",
    local: "local",
    cmdPlaceholder: "Enter command (Shift+Enter new line)",
    directInput: "Direct input (type here for interactive prompts)",
    inputOn: "Direct input: ON — keys go to terminal",
    inputOff: "Direct input: OFF — keys stay in browser",
    inputDisconnected: "Disconnected — input will not be sent",
    inputOffline: "Terminal offline — input will not be sent",
    deleteBlocked: "Cannot delete this terminal (still active or owned by another instance).",
    deleteFailed: "Delete failed.",
  },
  zh: {
    commands: "条命令",
    sessionGone: "会话不存在或已断开",
    noSession: "无终端会话，请先用 term_cli connect（SSH）或 term_cli local 建立。",
    terminals: "终端",
    transfers: "传输任务",
    transfersEmpty: "当前会话暂无传输任务。",
    transferUpload: "上传",
    transferDownload: "下载",
    transferRunning: "传输中",
    transferDone: "完成",
    transferFailed: "失败",
    local: "本地",
    cmdPlaceholder: "输入命令（Shift+Enter 换行）",
    directInput: "直接输入（交互输入请直接在此输入）",
    inputOn: "直接输入：已启用（按键发往终端）",
    inputOff: "直接输入：已关闭（按键留在浏览器）",
    inputDisconnected: "连接已断开，输入不会被送达",
    inputOffline: "终端未连接，输入不会被送达",
    deleteBlocked: "无法删除该终端（仍在活动或属于其他实例）。",
    deleteFailed: "删除失败。",
  },
}

/** 页面语言：由 server 渲染的 `<html lang>` 决定（非 zh 一律按 en 兜底） */
const DOC_LANG: "en" | "zh" = document.documentElement.lang === "zh" ? "zh" : "en"

/**
 * 合并注入文案与内置兜底：某键注入值不是非空字符串时回退**当前语言**的兜底，保证每个键都是可用文案。
 * @param raw window.__I18N__ 注入对象（可能为 undefined 或缺键）
 * @param lang 兜底语言（页面语言）
 * @returns 每个键均为非空字符串的 I18n
 */
function mergeI18n(raw: Partial<I18n> | undefined, lang: "en" | "zh"): I18n {
  const out: I18n = { ...I18N_FALLBACK[lang] }
  for (const k of Object.keys(I18N_FALLBACK[lang]) as (keyof I18n)[]) {
    const v = raw?.[k]
    if (typeof v === "string" && v.length > 0) out[k] = v
  }
  return out
}

const I18N: I18n = mergeI18n((window as unknown as { __I18N__?: Partial<I18n> }).__I18N__, DOC_LANG)
const PTY_COLS: number = (window as unknown as { __PTY_COLS__: number }).__PTY_COLS__ || 120
const PTY_ROWS: number = (window as unknown as { __PTY_ROWS__: number }).__PTY_ROWS__ || 40
/**
 * 应用层心跳参数（由 server 渲染页面时注入，来自 src/constants.ts）。
 * 缺省 0 = 旧缓存页面未注入：禁用心跳（不猜默认值），而非静默使用会漂移的魔法数。
 */
const HEARTBEAT_INTERVAL_MS: number = (window as unknown as { __HEARTBEAT_INTERVAL_MS__?: number }).__HEARTBEAT_INTERVAL_MS__ || 0
const HEARTBEAT_CLIENT_TIMEOUT_MS: number = (window as unknown as { __HEARTBEAT_CLIENT_TIMEOUT_MS__?: number }).__HEARTBEAT_CLIENT_TIMEOUT_MS__ || 0

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
/** WS 是否处于已连接状态（输入可用性判定之一） */
let wsUp = false
/** 断线自动重连定时器（null 表示未排队，避免重复连接） */
let reconnectTimer: number | null = null
/** 最近一次收到 server 应用层 ping 的时刻（毫秒） */
let lastPingAt = 0
/** 心跳检测定时器（null 表示未启动；断开时清理） */
let heartbeatTimer: number | null = null
/** 命令框/直接输入当前是否可用（由 applyInputState 依据 WS 与终端连接状态维护） */
let inputEnabled = false
/** 直接输入开关的历史持久化键（已废弃：改为焦点驱动，仅用于启动时清理旧值，避免残留影响默认） */
const DIRECT_INPUT_PREF_KEY = "directInput"
/** 直接输入开关：由焦点驱动，默认关（命令框优先）；点终端区域/入口按钮开启，焦点回命令框即关闭 */
let directInputOn = false
let sessionsData: SessionStatus[] = []
/** 全部会话的传输任务（面板按当前选中终端过滤展示；server 快照/广播同源） */
let transferTasks: TransferTask[] = []
let stickToBottom = true
let runScreen: HeadlessScreen | null = null
/** 当前活动输出块（diff 渲染用，固化后保留在 DOM，后续命令不再复用/删除） */
let curBlock: HTMLDivElement | null = null
let debugMode = false
/** 用户配置的 raw 意图（历史会话可用 history 重建 raw 流，无需依赖实时连接） */
let prefRaw = localStorage.getItem("debugMode") === "1"
/** 删除按钮初始标题（server 渲染的默认提示；禁用时临时替换为不可删原因） */
let delTitleDefault = ""

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
/** 断线自动重连间隔（毫秒） */
const RECONNECT_MS = 2000

function connectWs(): void {
  wsUp = false
  applyInputState()
  ws = new WebSocket("ws://" + window.location.host + "/ws")
  ws.onopen = () => {
    wsUp = true
    // 重连后强制重新订阅：清空去重键，否则 subscribe() 会因 sid/name 未变而跳过
    subSid = ""
    subName = ""
    ws!.send(JSON.stringify({ type: "list" }))
    subscribe()
    applyInputState()
    startHeartbeat()
  }
  ws.onmessage = (ev) => {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(ev.data as string) as Record<string, unknown>
    } catch {
      return
    }
    switch (msg.type) {
      case "ping":
        // 应用层心跳：刷新存活时刻并回 pong；本端只关心"是否还能收到 server 的 ping"
        lastPingAt = Date.now()
        ws!.send(JSON.stringify({ type: "pong" }))
        break
      case "sessions": updateSessions(msg as unknown as { sessions: SessionStatus[] }); break
      case "snapshot": handleSnapshot(msg as unknown as { sessionID: string; name: string; pairs: TranscriptPair[]; notFound?: boolean }); break
      case "meta": handleMeta(msg as unknown as { sessionID: string; name: string; commands: number }); break
      case "diff": handleDiff(msg as unknown as { sessionID: string; name: string; event: string; command?: string; data?: string; exitCode?: number; endTs?: number; ts?: number }); break
      case "raw": handleRaw(msg as unknown as { data: string; reset?: boolean }); break
      case "deleteResult": handleDeleteResult(msg as unknown as { sessionID: string; name: string; ok: boolean; reason?: string }); break
      case "transfer": upsertTransferTask(msg.task as unknown as TransferTask); break
      case "transfer-remove": removeTransferTask(msg.id); break
      case "transfers": applyTransferSnapshot(msg as unknown as { scope?: string; sessionID?: string; name?: string; tasks?: TransferTask[] }); break
    }
  }
  ws.onclose = () => {
    // 断线：禁用输入并显示原因，随后自动重连（恢复后 onopen 重新订阅并解除禁用）
    stopHeartbeat()
    wsUp = false
    applyInputState()
    scheduleReconnect()
  }
}

/**
 * 启动心跳检测：server 每 HEARTBEAT_INTERVAL_MS 下发一次 ping，本端在 onmessage 回 pong 并刷新 lastPingAt。
 * 持续静默超过 HEARTBEAT_CLIENT_TIMEOUT_MS 即判定服务端半开（socket 已死但本端不知、收不到 close），
 * 主动 close → 走既有自动重连，实现"可发现 + 可自愈"。
 */
function startHeartbeat(): void {
  if (HEARTBEAT_INTERVAL_MS <= 0) return
  lastPingAt = Date.now()
  if (heartbeatTimer !== null) return
  heartbeatTimer = window.setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    if (Date.now() - lastPingAt > HEARTBEAT_CLIENT_TIMEOUT_MS) ws.close()
  }, HEARTBEAT_INTERVAL_MS)
}

/** 停止心跳检测（连接关闭时调用，避免残留定时器） */
function stopHeartbeat(): void {
  if (heartbeatTimer !== null) {
    window.clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

/** 断线自动重连：单一定时器排队，避免重复连接 */
function scheduleReconnect(): void {
  if (reconnectTimer !== null) return
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null
    connectWs()
  }, RECONNECT_MS)
}

// ===== 传输任务面板 =====
/** 状态展示排序权重（固定口径：running 优先；其余同组内按 startedAt 降序） */
const TRANSFER_STATE_RANK: Record<TransferTask["state"], number> = { running: 0, done: 1, failed: 1 }

/**
 * 按固定口径排序传输任务：running 优先，其余按开始时间降序。
 * @param tasks 任务数组（不修改原数组）
 * @returns 新数组
 */
function sortTransferTasks(tasks: TransferTask[]): TransferTask[] {
  return [...tasks].sort((a, b) => {
    const rank = TRANSFER_STATE_RANK[a.state] - TRANSFER_STATE_RANK[b.state]
    return rank !== 0 ? rank : b.startedAt - a.startedAt
  })
}

/**
 * 状态文案（走 i18n；未知状态按 running 兜底，避免显示 undefined）。
 * @param state 任务状态
 * @returns 本地化状态文案
 */
function transferStateText(state: TransferTask["state"]): string {
  if (state === "done") return I18N.transferDone
  if (state === "failed") return I18N.transferFailed
  return I18N.transferRunning
}

/**
 * 字节数转人类可读文本（B/KiB/MiB/GiB，保留 1 位小数）。
 * @param n 字节数
 * @returns 展示文本
 */
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B"
  if (n < 1024) return Math.round(n) + " B"
  const units = ["KiB", "MiB", "GiB", "TiB"]
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return v.toFixed(1) + " " + units[i]
}

/**
 * 耗时转展示文本（秒级；>=60s 用 m s）。
 * @param ms 毫秒
 * @returns 展示文本
 */
function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000))
  if (totalSec < 60) return totalSec + "s"
  return Math.floor(totalSec / 60) + "m " + (totalSec % 60) + "s"
}

/** 当前选中会话 ID（无选中返回空串） */
function currentSessionId(): string {
  return (document.getElementById("session") as HTMLSelectElement).value
}

/** 当前选中终端名（无选中返回空串） */
function currentTerminalName(): string {
  return (document.getElementById("terminal") as HTMLSelectElement).value
}

/**
 * 单行任务 DOM。**所有动态文本一律走 textContent**（路径/终端名/错误码均不可信，禁止拼 innerHTML）。
 * @param task 传输任务元数据
 * @returns 行元素
 */
function renderTransferRow(task: TransferTask): HTMLElement {
  const row = document.createElement("div")
  row.className = "transfer-row state-" + task.state

  const head = document.createElement("div")
  head.className = "transfer-row-head"

  const dir = document.createElement("span")
  dir.className = "transfer-dir " + task.direction
  dir.textContent = (task.direction === "upload" ? "↑ " : "↓ ") +
    (task.direction === "upload" ? I18N.transferUpload : I18N.transferDownload)

  const name = document.createElement("span")
  name.className = "transfer-name"
  name.textContent = task.name
  name.title = task.name

  const bytes = document.createElement("span")
  bytes.className = "transfer-bytes"
  // total 未知（0）时：running 显示 ?；done/failed 用实际 bytes（空文件也是 0 B）
  const totalText = task.total > 0 ? formatBytes(task.total) : (task.state === "running" ? "?" : formatBytes(task.bytes))
  bytes.textContent = formatBytes(task.bytes) + " / " + totalText

  // running 用当前时刻估算耗时（进度事件约 250ms 一次会触发重渲染，因此数值持续刷新）
  const elapsed = Math.max(0, (task.endedAt ?? Date.now()) - task.startedAt)
  const duration = document.createElement("span")
  duration.className = "transfer-duration"
  duration.textContent = formatDuration(elapsed)

  const state = document.createElement("span")
  state.className = "transfer-state " + task.state
  state.textContent = transferStateText(task.state)

  head.append(dir, name, bytes, duration, state)
  row.appendChild(head)

  // 进度条：total=0 的 running 用不确定态；done 用实际 bytes/total（total=0 视为 100%）；failed 保留已传比例
  const progress = document.createElement("div")
  progress.className = "transfer-progress"
  const bar = document.createElement("div")
  bar.className = "transfer-bar"
  if (task.state === "running" && task.total <= 0) {
    progress.classList.add("indeterminate")
  } else {
    const pct = task.total > 0 ? (task.bytes / task.total) * 100 : (task.state === "done" ? 100 : 0)
    bar.style.width = Math.max(0, Math.min(100, pct)).toFixed(1) + "%"
  }
  progress.appendChild(bar)
  row.appendChild(progress)

  const paths = document.createElement("div")
  paths.className = "transfer-paths"
  const local = document.createElement("span")
  local.className = "transfer-path transfer-local"
  local.textContent = task.localPath
  local.title = task.localPath
  const arrow = document.createElement("span")
  arrow.className = "transfer-arrow"
  arrow.textContent = "↔"
  const remote = document.createElement("span")
  remote.className = "transfer-path transfer-remote"
  remote.textContent = task.remotePath
  remote.title = task.remotePath
  paths.append(local, arrow, remote)
  row.appendChild(paths)

  if (task.state === "failed") {
    const err = document.createElement("div")
    err.className = "transfer-error"
    err.textContent = task.errorCode || I18N.transferFailed
    row.appendChild(err)
  }
  return row
}

/** 传输浮窗位置持久化键（只存 left/top；恢复与 resize 时按当前视口重新 clamp） */
const TRANSFER_PANEL_POS_KEY = "transferPanelPos"
/** 浮窗与视口边缘的最小间距（px），拖动/恢复/resize 共用 */
const TRANSFER_PANEL_MARGIN = 8
/** 标题栏拖动提示（纯前端交互提示，不进 server i18n 载荷） */
const TRANSFER_DRAG_HINT: Record<"en" | "zh", string> = { en: "Drag to move", zh: "拖动移动" }

/** 一次拖动会话的快照：指针起点、浮窗起点与拖动开始时的尺寸（getBoundingClientRect） */
interface TransferDragState {
  pointerId: number
  originX: number
  originY: number
  startLeft: number
  startTop: number
  width: number
  height: number
}

/** 进行中的拖动（null 表示未在拖动） */
let transferDrag: TransferDragState | null = null

/**
 * 重渲染传输任务面板：只展示当前选中终端（sessionID + 终端名）的任务；无选中会话/终端固定展示空态
 * （不跨会话、不跨终端混显）。计数与空态口径一致，只算当前终端。
 */
function renderTransferPanel(): void {
  const list = document.getElementById("transferList")
  const countEl = document.getElementById("transferCount")
  if (!list || !countEl) return
  const sid = currentSessionId()
  const name = currentTerminalName()
  const tasks = sid && name ? transferTasks.filter((t) => t.sessionID === sid && t.name === name) : []
  countEl.textContent = String(tasks.length)
  list.textContent = ""
  if (tasks.length === 0) {
    const empty = document.createElement("div")
    empty.className = "transfer-empty"
    empty.textContent = I18N.transfersEmpty
    list.appendChild(empty)
    return
  }
  for (const task of tasks) list.appendChild(renderTransferRow(task))
}

/**
 * 切换传输任务浮窗显示状态（header 按钮与浮窗关闭按钮共用）。
 * @param open 目标状态；省略时按当前状态取反（true=展开）
 */
function toggleTransferPanel(open?: boolean): void {
  const panel = document.getElementById("transferPanel")
  const toggle = document.getElementById("transferToggle")
  if (!panel || !toggle) return
  const next = open ?? panel.hidden
  panel.hidden = !next
  toggle.setAttribute("aria-expanded", next ? "true" : "false")
  // 重新展开时按当前视口复位记忆位置，避免上次的坐标把浮窗留在屏幕外
  if (next) clampTransferPanelIntoView()
}

// ===== 传输浮窗拖动（标题栏为拖动柄；仍为 fixed，不占 layout） =====

/**
 * 把浮窗坐标限制在可视区域内（四周至少留 TRANSFER_PANEL_MARGIN，不允许拖出屏幕）。
 * @param left 期望的 left（px）
 * @param top 期望的 top（px）
 * @param width 浮窗宽度（px，取 getBoundingClientRect）
 * @param height 浮窗高度（px，取 getBoundingClientRect）
 * @returns 已 clamp 的 left/top
 */
function clampTransferPanelPos(left: number, top: number, width: number, height: number): { left: number; top: number } {
  const m = TRANSFER_PANEL_MARGIN
  const maxLeft = Math.max(m, window.innerWidth - width - m)
  const maxTop = Math.max(m, window.innerHeight - height - m)
  return { left: Math.min(Math.max(left, m), maxLeft), top: Math.min(Math.max(top, m), maxTop) }
}

/**
 * 以 left/top 定位浮窗（拖动后使用）；同时清空 right/bottom，避免两种定位互相覆盖。
 * @param panel 浮窗元素
 * @param left 目标 left（px）
 * @param top 目标 top（px）
 */
function applyTransferPanelPos(panel: HTMLElement, left: number, top: number): void {
  panel.style.left = Math.round(left) + "px"
  panel.style.top = Math.round(top) + "px"
  panel.style.right = "auto"
  panel.style.bottom = "auto"
}

/**
 * 按当前视口重新 clamp 已手动定位的浮窗；仍是默认 right/bottom 定位（未拖动过）时不动。
 * 用于恢复记忆位置、窗口 resize、浮窗重新展开与内容高度变化。
 */
function clampTransferPanelIntoView(): void {
  const panel = document.getElementById("transferPanel")
  if (!panel || panel.hidden) return
  if (!panel.style.left || !panel.style.top) return
  const rect = panel.getBoundingClientRect()
  const pos = clampTransferPanelPos(rect.left, rect.top, rect.width, rect.height)
  applyTransferPanelPos(panel, pos.left, pos.top)
}

/** 读取持久化的浮窗位置（只存 left/top）；缺失或非法时返回 null */
function loadTransferPanelPos(): { left: number; top: number } | null {
  try {
    const raw = localStorage.getItem(TRANSFER_PANEL_POS_KEY)
    if (!raw) return null
    const pos = JSON.parse(raw) as { left?: unknown; top?: unknown }
    if (typeof pos.left !== "number" || typeof pos.top !== "number") return null
    if (!Number.isFinite(pos.left) || !Number.isFinite(pos.top)) return null
    return { left: pos.left, top: pos.top }
  } catch {
    return null
  }
}

/**
 * 记住浮窗位置（只存 left/top）。
 * @param left 最终 left（px）
 * @param top 最终 top（px）
 */
function saveTransferPanelPos(left: number, top: number): void {
  try {
    localStorage.setItem(TRANSFER_PANEL_POS_KEY, JSON.stringify({ left: Math.round(left), top: Math.round(top) }))
  } catch {
    // 存储不可用（隐私模式/超额）时只丢记忆，不影响拖动
  }
}

/**
 * 标题栏按下：记录拖动起点、切换为 left/top 定位并捕获指针。
 * 关闭按钮上的按下直接放行，保证点击关闭仍生效。
 * @param ev 标题栏 pointerdown
 */
function onTransferHeadPointerDown(ev: PointerEvent): void {
  const panel = document.getElementById("transferPanel")
  const head = ev.currentTarget as HTMLElement | null
  if (!panel || !head) return
  if (ev.pointerType === "mouse" && ev.button !== 0) return
  if ((ev.target as Element | null)?.closest(".transfer-close")) return
  const rect = panel.getBoundingClientRect()
  transferDrag = {
    pointerId: ev.pointerId,
    originX: ev.clientX,
    originY: ev.clientY,
    startLeft: rect.left,
    startTop: rect.top,
    width: rect.width,
    height: rect.height,
  }
  applyTransferPanelPos(panel, rect.left, rect.top)
  head.setPointerCapture(ev.pointerId)
  // 阻止拖动时选中文本/触发后续点击
  ev.preventDefault()
}

/**
 * 拖动中：按指针位移换算新坐标并 clamp 在视口内。
 * @param ev 标题栏 pointermove
 */
function onTransferHeadPointerMove(ev: PointerEvent): void {
  const drag = transferDrag
  const panel = document.getElementById("transferPanel")
  if (!drag || !panel || ev.pointerId !== drag.pointerId) return
  const pos = clampTransferPanelPos(
    drag.startLeft + (ev.clientX - drag.originX),
    drag.startTop + (ev.clientY - drag.originY),
    drag.width,
    drag.height,
  )
  applyTransferPanelPos(panel, pos.left, pos.top)
  ev.preventDefault()
}

/**
 * 拖动结束（pointerup / pointercancel）：释放指针捕获、clamp 并记住最终位置。
 * @param ev 标题栏 pointerup / pointercancel
 */
function onTransferHeadPointerUp(ev: PointerEvent): void {
  const drag = transferDrag
  if (!drag || ev.pointerId !== drag.pointerId) return
  transferDrag = null
  const head = ev.currentTarget as HTMLElement | null
  if (head?.hasPointerCapture(ev.pointerId)) head.releasePointerCapture(ev.pointerId)
  const panel = document.getElementById("transferPanel")
  if (!panel || panel.hidden) return
  const rect = panel.getBoundingClientRect()
  const pos = clampTransferPanelPos(rect.left, rect.top, rect.width, rect.height)
  applyTransferPanelPos(panel, pos.left, pos.top)
  saveTransferPanelPos(pos.left, pos.top)
}

/**
 * 初始化浮动窗口拖动：恢复记忆位置、绑定标题栏 pointer 事件、窗口 resize 时重新 clamp。
 * 面板仍是 fixed 定位（不占 layout），只改变 left/top 与 right/bottom 的取舍。
 */
function setupTransferPanelDrag(): void {
  const panel = document.getElementById("transferPanel")
  if (!panel) return
  const head = panel.querySelector(".transfer-panel-head") as HTMLElement | null
  if (!head) return
  head.title = TRANSFER_DRAG_HINT[DOC_LANG]
  head.addEventListener("pointerdown", onTransferHeadPointerDown)
  head.addEventListener("pointermove", onTransferHeadPointerMove)
  head.addEventListener("pointerup", onTransferHeadPointerUp)
  head.addEventListener("pointercancel", onTransferHeadPointerUp)
  window.addEventListener("resize", clampTransferPanelIntoView)
  // 内容增减改变高度时也保持浮窗在视口内（ResizeObserver 回调由浏览器合并，避免每次渲染读布局）
  new ResizeObserver(() => {
    if (!transferDrag) clampTransferPanelIntoView()
  }).observe(panel)
  const saved = loadTransferPanelPos()
  if (!saved) return
  const rect = panel.getBoundingClientRect()
  const pos = clampTransferPanelPos(saved.left, saved.top, rect.width, rect.height)
  applyTransferPanelPos(panel, pos.left, pos.top)
}

/**
 * 广播任务 upsert（同 id 覆盖，保留其它任务）。
 * @param task 已校验的任务元数据（缺 id 时忽略）
 */
function upsertTransferTask(task: TransferTask): void {
  if (!task || typeof task.id !== "string") return
  const idx = transferTasks.findIndex((t) => t.id === task.id)
  if (idx >= 0) transferTasks[idx] = task
  else transferTasks.push(task)
  transferTasks = sortTransferTasks(transferTasks)
  renderTransferPanel()
}

/**
 * 服务端任务删除通知（过期清理等）：按 id 移除本地行并重渲染。
 * @param id 任务 id（非字符串/空值忽略）
 */
function removeTransferTask(id: unknown): void {
  if (typeof id !== "string" || !id) return
  const next = transferTasks.filter((t) => t.id !== id)
  if (next.length === transferTasks.length) return
  transferTasks = next
  renderTransferPanel()
}

/**
 * 应用快照：`scope==="all"` 全量替换；带 `sessionID`+`name` 只替换该会话该终端的任务、保留其他终端与会话。
 * 缺 name（或只带 sessionID）的快照直接忽略，避免误清空其他终端（避免按会话整体替换）。
 * @param msg 快照消息
 */
function applyTransferSnapshot(msg: { scope?: string; sessionID?: string; name?: string; tasks?: TransferTask[] }): void {
  const incoming = Array.isArray(msg.tasks) ? msg.tasks : []
  if (msg.scope === "all") {
    transferTasks = sortTransferTasks(incoming)
  } else if (typeof msg.sessionID === "string" && msg.sessionID && typeof msg.name === "string" && msg.name) {
    const { sessionID, name } = msg
    transferTasks = sortTransferTasks([
      ...transferTasks.filter((t) => !(t.sessionID === sessionID && t.name === name)),
      ...incoming,
    ])
  } else {
    return
  }
  renderTransferPanel()
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
  renderTransferPanel()
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
  renderTransferPanel()
}

/** 根据当前终端连接/忙状态更新输入框与直接输入入口可用性 */
function updateCmdBar(): void {
  // Raw 开关始终可用：在线走实时流，离线历史会话由 server 从 history 重建 raw 流
  const rawCb = document.getElementById("debugMode") as HTMLInputElement
  const rawToggle = document.getElementById("rawToggle")
  rawCb.disabled = false
  if (rawToggle) rawToggle.classList.remove("disabled")
  rawCb.checked = prefRaw
  debugMode = effRaw()
  if (debugMode) showRawUi()
  else hideRawUi()
  applyInputState()
}

/**
 * 输入可用性判定：WS 在线 且 当前选中终端已连接
 * @returns enabled=是否可用；reason=不可用原因（可用时为空串）
 */
function inputState(): { enabled: boolean; reason: string } {
  if (!wsUp) return { enabled: false, reason: I18N.inputDisconnected }
  const sid = (document.getElementById("session") as HTMLSelectElement).value
  const name = (document.getElementById("terminal") as HTMLSelectElement).value
  const term = sessionsData.find((x) => x.sessionID === sid)?.terminals.find((t2) => (t2.name || "default") === name)
  if (!sid || !name || !term?.connected) return { enabled: false, reason: I18N.inputOffline }
  return { enabled: true, reason: "" }
}

/**
 * 应用输入可用性到界面：离线/终端断开时禁用命令框并显示原因，恢复后自动解除。
 * 直接输入（文档级按键捕获）由 inputEnabled 同步约束。
 */
function applyInputState(): void {
  const st = inputState()
  const wasEnabled = inputEnabled
  inputEnabled = st.enabled
  const cmdInput = document.getElementById("cmdInput") as HTMLTextAreaElement
  cmdInput.disabled = !st.enabled
  cmdInput.placeholder = st.enabled ? (I18N.cmdPlaceholder || "") : st.reason
  cmdInput.title = st.reason
  // 由「不可用」转「可用」（首次就绪/重连恢复）：默认焦点交还命令框并关闭直接输入，
  // 保证「命令框优先」且焦点状态与显示一致（不会出现显示已启用、实际焦点在命令框的错位）。
  if (st.enabled && !wasEnabled) {
    setDirectInput(false)
    cmdInput.focus()
  }
  updateCmdKey()
  const status = document.getElementById("connStatus")
  if (status) {
    status.textContent = st.enabled ? "" : st.reason
    status.classList.toggle("show", !st.enabled)
  }
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
  // 删除按钮：当前终端已断开时显示；能否点击由后端"可删"判据决定（不可删则禁用并给出原因提示）
  const cur = s?.terminals.find((t) => (t.name || "default") === tsel.value)
  const showDel = !!(cur && !cur.connected)
  delBtn.classList.toggle("show", showDel)
  const canDelete = !!(cur && cur.canDelete)
  delBtn.disabled = !canDelete
  delBtn.title = showDel && !canDelete ? (cur?.deleteReason || I18N.deleteBlocked) : delTitleDefault
  updateCmdBar()
  updateMetaFromSessions()
  renderTransferPanel()
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

/**
 * 可见完成标记剥离（退出码恒在末尾；展示给用户/模型的输出前调用）。
 * 兼容三种格式：`<SSH_DONE:code>`（旧）/`<SSH_DONE:seq:code>`（旧序号式）/
 * `<SSH_DONE:nonce:seq:code>`（现用：nonce 为会话级随机串，可为字母数字）。与后端 shell-adapter 的 DONE_RE 保持一致。
 */
const DONE_RE = /<SSH_DONE:(?:[0-9A-Za-z]+:)?(?:\d+:)?(-?\d+)>/g
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
  // 历史-only 条目没有 title/host：优先用终端名，避免显示成 sessionID
  if (t && t.name && t.name !== "default") return t.name
  if (t && t.program) return t.program
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
  // 后端判为不可删（仍活动/属他实例）：按钮通常已禁用，此处兜底给出可见原因，不发请求
  if (!t.canDelete) {
    showNotice(t.deleteReason || I18N.deleteBlocked)
    return
  }
  // 删除结果由后端 deleteResult 回执驱动（成功才本地移除；被拒则显示原因），不做乐观删除
  ws.send(JSON.stringify({ type: "deleteTerminal", sessionID: sid, name }))
}

/**
 * 处理后端删除回执：成功则本地移除该终端（即时反馈，随后 server 状态推送会再次对齐）；
 * 失败则显示后端返回的可读原因（绝不静默无反应）。
 * @param msg deleteResult 消息
 */
function handleDeleteResult(msg: { sessionID: string; name: string; ok: boolean; reason?: string }): void {
  if (msg.ok) {
    removeTerminalLocally(msg.sessionID, msg.name)
    return
  }
  showNotice(msg.reason || I18N.deleteFailed)
}

/**
 * 从本地 sessionsData 移除指定终端并刷新下拉/删除按钮；删光则清空界面。
 * @param sid 主会话 ID
 * @param name 终端名
 */
function removeTerminalLocally(sid: string, name: string): void {
  const s = sessionsData.find((x) => x.sessionID === sid)
  if (s) {
    s.terminals = s.terminals.filter((t2) => (t2.name || "default") !== name)
    if (s.terminals.length === 0) sessionsData = sessionsData.filter((x) => x.sessionID !== sid)
  }
  if (sessionsData.length === 0) {
    clearAllTerminals()
    return
  }
  const prev = (document.getElementById("terminal") as HTMLSelectElement).value
  updateTerminalSelect(prev !== name ? prev : undefined)
}

/** 页面级提示自动消失定时器（null 表示当前无提示） */
let noticeTimer: number | null = null

/**
 * 显示一条页面级提示并自动消失（删除被拒等需要可见反馈的场景）。
 * @param text 提示文案
 */
function showNotice(text: string): void {
  const el = document.getElementById("notice")
  if (!el) return
  el.textContent = text
  el.classList.add("show")
  if (noticeTimer !== null) window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => {
    el.classList.remove("show")
    noticeTimer = null
  }, 5000)
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
delTitleDefault = (document.getElementById("delTerm") as HTMLButtonElement | null)?.getAttribute("title") || ""
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

// ===== 直接输入（交互输入）=====
// 由焦点驱动：页面默认焦点在命令框（按键留在浏览器、走 exec 发命令）；
// 点终端区域（transcript `#term` / raw `#xt`）或入口按钮 → 启用（按键走 type:"send" keystroke 通道，
// 不产生 exec、不写命令记录）；焦点回到命令框/其它可编辑控件 → 自动关闭。
// 状态不持久化，每次打开都是「命令框优先」。指示器文案始终跟随开关，二者共用一个入口，不会错位。
// 按键 → 终端字节序列的映射（含 Home/End/PgUp/PgDn/Delete/Shift+Tab/Esc 等）集中在 ./keys.ts；
// 发送的是**真实控制字节**（0x7f/0x09/ESC 引导序列），与后端通用解码口径一致（见 src/escapes.ts）。

/** 当前按键事件是否落在可编辑/表单控件上（是则不拦截，交由其正常处理） */
function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el || !el.tagName) return false
  const tag = el.tagName.toUpperCase()
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON" || el.isContentEditable
}

/**
 * 目标是否位于终端展示区域（transcript `#term` / raw `#xt`，含 xterm 内部辅助 textarea）。
 * 该区域内的可编辑控件（xterm 隐藏输入框）不算「命令框」，不应据此关闭直接输入。
 * @param t 事件目标
 * @returns 是否在终端区域内
 */
function inTerminalArea(t: EventTarget | null): boolean {
  const el = t as Element | null
  return !!el && typeof el.closest === "function" && !!el.closest("#term, #xt")
}

/** 发送一段按键文本到当前终端（keystroke 通道，不写命令记录） */
function sendKeystroke(text: string): void {
  const sid = (document.getElementById("session") as HTMLSelectElement).value
  const name = (document.getElementById("terminal") as HTMLSelectElement).value
  if (!sid || !ws || ws.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify({ type: "send", sessionID: sid, name, text }))
}

/**
 * 刷新直接输入指示器：文案随开关状态（中/英），高亮随可用性。
 * 关闭＝按键留在浏览器（命令框优先）；启用＝按键发往终端。
 * 端点离线/WS 断开时叠加 disabled 样式（原因由 connStatus 显示）。
 */
function updateCmdKey(): void {
  const key = document.getElementById("cmdKey") as HTMLSpanElement | null
  if (!key) return
  key.textContent = directInputOn ? (I18N.inputOn || I18N.directInput) : (I18N.inputOff || I18N.directInput)
  key.classList.toggle("on", directInputOn)
  key.classList.toggle("off", !directInputOn)
  key.classList.toggle("disabled", !inputEnabled)
  key.title = I18N.directInput || ""
  key.setAttribute("aria-pressed", directInputOn ? "true" : "false")
}

/** 设置直接输入开关并即时刷新指示器（唯一改状态入口，保证显示与实际生效一致） */
function setDirectInput(on: boolean): void {
  if (directInputOn === on) return
  directInputOn = on
  updateCmdKey()
}

// 入口指示器即开关：点击显式切换（与焦点驱动共享同一状态，二者不会打架）
const cmdKey = document.getElementById("cmdKey") as HTMLSpanElement
cmdKey.setAttribute("role", "switch")
cmdKey.addEventListener("click", () => setDirectInput(!directInputOn))

// 焦点驱动：点终端区域启用；焦点落到命令框/其它可编辑控件（终端辅助 textarea 除外）即关闭
document.addEventListener("click", (ev) => {
  if (inTerminalArea(ev.target)) setDirectInput(true)
})
document.addEventListener("focusin", (ev) => {
  if (isEditableTarget(ev.target) && !inTerminalArea(ev.target)) setDirectInput(false)
})

/**
 * 直接输入按键处理：开关开启且终端可用时生效。
 * 焦点在命令框/选择框等控件上、浏览器快捷键、Cmd 组合、端点离线时一律不拦截。
 * @param ev keydown 事件
 */
function onDirectInputKeydown(ev: KeyboardEvent): void {
  if (!directInputOn) return
  if (isEditableTarget(ev.target) && !inTerminalArea(ev.target)) return
  if (!inputEnabled) return
  const seq = mapKeystroke(ev)
  if (seq === null) return
  ev.preventDefault()
  sendKeystroke(seq)
}
document.addEventListener("keydown", onDirectInputKeydown, true)

// 清理旧的持久化值：状态改由焦点驱动，保证每次打开都是「命令框优先」而非上次的残留
localStorage.removeItem(DIRECT_INPUT_PREF_KEY)
updateCmdKey()
setupTransferPanelDrag()
renderTransferPanel()

Object.assign(window, {
  onSessionChange,
  onShowTimeChange,
  onDebugModeChange,
  deleteTerminal,
  scrollToNewest,
  toggleTransferPanel,
})

connectWs()