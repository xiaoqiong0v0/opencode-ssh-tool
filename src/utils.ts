// 工具函数：命令回显定位、模型文本清理、ANSI 清洗、CR 覆盖合并、完成标记剥离

import { stripMarkers } from "./shell-adapter.js"
import { findLastEndOf } from "./last-match.js"

/** 正则转义文本 */
const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** 命令回显匹配的宽松字符间隙（ANSI 序列或普通空白/换行，可插在命令字符之间；容忍终端列宽自动换行） */
const ECHO_WIDE = "(?:\\x1b\\[[0-9;?]*[a-zA-Z]|\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)|\\x1b[^\\x1b]|[ \\t\\r\\n])*"

/**
 * 定位命令回显行在原始流中的结束位置（供流式增量定位使用）：
 * 丢弃窗口开头到"命令回显行结束"之前的一切内容（提示符、PS1 填充、光标定位噪音均在内）。
 * 命令回显行 = 命令文本首次出现所在行（命令本身可能含 \033 等转义）。
 * @param raw 原始终端流（含 ANSI）
 * @param command 本次执行的命令文本
 * @returns 命令回显结束后的字节偏移；未命中命令文本返回 0（此时应视作输出尚未开始）
 */
export function extractOutputStart(raw: string, command: string): number {
  const cmd = command.trim()
  if (!cmd) return 0
  // 单条宽松正则一次性匹配命令回显（命令文本 + 字符间 ANSI 间隙）：
  // 1) 字符间容忍 ANSI 间隙（WIDE）2) 命令字面 \033 回显可能变真实 ESC（二选一）
  const norm = cmd.replace(/\\033/gi, "\x1b")
  const frags = [...norm].map((c) => (c === "\x1b" ? "(?:\\x1b|\\\\033)" : escRe(c)))
  const re = new RegExp(frags.join(ECHO_WIDE), "g")
  // 取最后一次匹配：备屏退出（如 cmatrix）会重放主屏历史，其中含旧命令回显，
  // 只有最后一次出现的回显之后才是本次命令的真实输出
  return findLastEndOf(re, raw)
}

/**
 * 剥离"提示符 + 命令回显"，只保留程序纯输出：
 * shell 提示符（含背景填充、zle 重绘序列）依赖其自身终端屏幕状态，字节流脱离该状态无法忠实还原，
 * 故丢弃窗口开头到"命令回显行结束"之前的一切内容（提示符、PS1 填充、光标定位噪音均在内）。
 * 命令回显行 = 命令文本首次出现所在行（命令本身可能含 \033 等转义）。
 * 命中后切到"命令文本结束处"：zsh 下程序输出可能直接粘连在回显尾（无换行），不能按换行截断。
 * @param raw 原始终端流（含 ANSI）
 * @param command 本次执行的命令文本
 * @returns 纯程序输出原始流（保留程序自身的 ANSI 颜色/进度条，供 web TermScreen 与模型 toModelText）
 */
export function extractOutput(raw: string, command: string): string {
  const end = extractOutputStart(raw, command)
  if (end <= 0) return raw
  return raw.slice(end).replace(/^[\r\n]+/, "")
}

/**
 * 把原始终端流转为给模型看的干净文本：模拟终端屏幕（处理光标移动/清行/覆盖/退格/SGR/OSC），
 * 输出最终屏幕各行文本，再逐行去尾空白并剔除空行。比纯文本正则更鲁棒地处理 PSReadLine
 * 行内重绘、进度条 \r 覆盖等场景。
 * @param raw 原始终端流（含 ANSI）
 * @returns 纯文本输出（供模型消费 / exec 返回值 / read 命令）
 */
export function toModelText(raw: string): string {
  const screen = simulateScreen(stripMarkers(raw))
  return screen
    .split(/\r?\n/)
    .map((l) => l.replace(/\r/g, "").trimEnd())
    .filter((l) => l !== "")
    .join("\n")
}

/**
 * 模拟终端屏幕渲染：处理 ANSI 光标/清行/清屏/退格/覆盖，输出最终各行的文本。
 * 不保留颜色/SGR，仅提取各行已写字符的最右列，确保最终屏幕文本与真实终端显示一致。
 * @param s 原始字节流（含 ANSI、\b、\r 等）
 * @returns 按行拼接的纯文本（行间 \n 分隔，行内保留空格）
 */
function simulateScreen(s: string): string {
  // 网格：每行 { maxCol: 已写最右列, cols: Map<col, char> }
  const rows: { maxCol: number; cols: Map<number, string> }[] = []
  let r = 0   // 当前行
  let c = 0   // 当前列
  let sr = 0  // 保存的光标行（ESC 7 / CSI s）
  let sc = 0  // 保存的光标列
  let altRows: typeof rows | null = null // 备屏保存（CSI ?1049h/l）
  const COLS = 240 // 足够宽

  const row = (i: number) => {
    while (rows.length <= i) rows.push({ maxCol: 0, cols: new Map() })
    return rows[i]
  }
  const put = (ch: string) => {
    const cur = row(r)
    if (c < COLS) {
      cur.cols.set(c, ch)
      if (c >= cur.maxCol) cur.maxCol = c + 1
    }
    c++
  }

  let i = 0
  const n = s.length
  while (i < n) {
    const ch = s[i]
    if (ch === "\x1b") {
      // OSC: ESC ] ... BEL/ESC\ — 整段丢弃
      if (i + 1 < n && s[i + 1] === "]") {
        let j = i + 2
        while (j < n && s[j] !== "\x07" && !(s[j] === "\x1b" && j + 1 < n && s[j + 1] === "\\")) j++
        if (j >= n) break
        i = s[j] === "\x07" ? j + 1 : j + 2
        continue
      }
      // CSI: ESC [ params... final
      if (i + 1 < n && s[i + 1] === "[") {
        let j = i + 2
        const start = j
        while (j < n && !/[A-Za-z@]/.test(s[j])) j++
        if (j >= n) break
        const body = s.slice(start, j)
        const final = s[j]
        const p = (d: string) => { const v = parseInt(d, 10); return Number.isFinite(v) && v > 0 ? v : 1 }
        const va = (d: string) => { const v = parseInt(d, 10); return Number.isFinite(v) && v >= 0 ? v : 0 }
        if (final === "m") {
          // SGR：忽略颜色
        } else if (final === "A") { r = Math.max(0, r - p(body)) }
        else if (final === "B") { r += p(body) }
        else if (final === "C") { c = Math.min(COLS - 1, c + p(body)) }
        else if (final === "D") { c = Math.max(0, c - p(body)) }
        else if (final === "H" || final === "f") {
          const m = body.split(";")
          r = Math.max(0, (p(m[0]) - 1))
          c = Math.max(0, (p(m[1]) - 1))
        }
        else if (final === "G" || final.charCodeAt(0) === 96) { c = Math.max(0, p(body) - 1) }
        else if (final === "d") { r = Math.max(0, p(body) - 1) }
        else if (final === "s") { sr = r; sc = c }
        else if (final === "u") { r = Math.min(sr, rows.length - 1); c = sc }
        else if (final === "h" && body.startsWith("?")) {
          // 私有模式 set：?1049h 进入备屏（保存主屏+光标，清屏）
          if (va(body.slice(1)) === 1049) {
            altRows = rows.map((x) => ({ maxCol: x.maxCol, cols: new Map(x.cols) }))
            sr = r; sc = c
            rows.length = 0; r = 0; c = 0
          }
        }
        else if (final === "l" && body.startsWith("?")) {
          // 私有模式 reset：?1049l 退出备屏（恢复主屏+光标）
          if (va(body.slice(1)) === 1049 && altRows) {
            rows.length = 0
            rows.push(...altRows)
            altRows = null
            r = Math.min(sr, rows.length - 1); c = sc
          }
        }
        else if (final === "K") {
          const mode = va(body)
          const curRow = row(r)
          if (mode === 2) { curRow.cols.clear(); curRow.maxCol = 0 }
          else if (mode === 1) { for (let ci = 0; ci <= c; ci++) { curRow.cols.delete(ci) }; curRow.maxCol = 0 }
          else { for (let ci = c; ci < COLS; ci++) { curRow.cols.delete(ci) }; curRow.maxCol = Math.min(curRow.maxCol, c) }
        }
        else if (final === "J") {
          const mode = va(body)
          if (mode === 2 || mode === 3) { rows.length = 0; r = 0; c = 0 }
          else if (mode === 1) { rows.length = 0; r = 0; c = 0 }
          else {
            const cur = row(r)
            for (let ci = c; ci < COLS; ci++) cur.cols.delete(ci)
            cur.maxCol = Math.min(cur.maxCol, c)
            rows.length = r + 1
          }
        }
        // 其余 CSI（滚动/插入/删除等）忽略
        i = j + 1
        continue
      }
      // ESC 7 保存光标 / ESC 8 恢复光标
      if (s[i + 1] === "7") { sr = r; sc = c; i += 2; continue }
      if (s[i + 1] === "8") { r = Math.min(sr, rows.length - 1); c = sc; i += 2; continue }
      // 其他 ESC 序列忽略
      i += 2
      continue
    }
    if (ch === "\r") { c = 0; i++; continue }
    if (ch === "\n") { r++; c = 0; i++; continue }
    if (ch === "\b") { if (c > 0) c--; i++; continue }
    if (ch === "\t") {
      const next = (Math.floor(c / 8) + 1) * 8
      if (next >= COLS) { r++; c = 0 }
      else c = next
      i++; continue
    }
    // 其他控制字符（\x07 BEL 等）跳过
    if (ch.charCodeAt(0) < 32) { i++; continue }
    put(ch)
    i++
  }

  // 构建输出行
  const lines: string[] = []
  for (let ri = 0; ri < rows.length; ri++) {
    const cur = rows[ri]
    if (cur.maxCol === 0) { lines.push(""); continue }
    let line = ""
    for (let ci = 0; ci < cur.maxCol; ci++) {
      line += cur.cols.get(ci) ?? " "
    }
    lines.push(line)
  }
  return lines.join("\n")
}

/**
 * 末尾空白清理（原为提示符剥离，现仅做清理，不依赖正则匹配具体提示符形状）
 * @param s 文本
 * @returns 清理后文本
 */
export function stripPrompt(s: string): string {
  return s.trimEnd()
}

/**
 * 时间戳格式化为 yyyy-MM-dd HH:mm:ss
 * @param ts 毫秒时间戳
 * @returns 格式化时间
 */
export function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
