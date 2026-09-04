// 工具函数：哨兵生成、注入剔除、模型文本清理、ANSI 清洗、CR 覆盖合并、提示符剥离

import { randomBytes } from "node:crypto"

/** 单个 ANSI 序列片段（CSI 光标/颜色控制，如 ESC[?2004h） */
const ANSI_CHUNK = "\\x1b\\[[0-9;?]*[a-zA-Z]"
/** ANSI 或普通空白（制表/空格）构成的间隙，可插在任意两个字符/词之间（不跨换行） */
const GAP = `(?:(?:${ANSI_CHUNK})|[ \\t])*`
/** 正则转义文本 */
const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
/** 把字符串每个字符转义后，字符间用 GAP 串起来（容忍 bash 回显时在字符间隙插入 ANSI 序列） */
const interleave = (s: string): string => [...s].map(escRe).join(GAP)

/**
 * 生成命令完成哨兵标记（随机后缀防撞词）
 * @returns 哨兵字符串
 */
export function genSentinel(): string {
  return `__SSH_DONE_${randomBytes(6).toString("hex")}__`
}

/**
 * 从命令捕获窗口原始字节流中剔除我们注入的哨兵痕迹（其余内容逐字节保真）：
 * 1. 命令回显行末尾拼接的 `; echo SENTINEL` 片段（保留原命令本体，如 `cmd; echo SENTINEL` → `cmd`）
 * 2. 若整行恰为哨兵本体（`echo SENTINEL` 的执行输出），整行删除
 * 不 trim、不删空行、不折叠换行、不动 ANSI —— 存储层/渲染层拿到的是接近真实终端屏幕的字节流，
 * 由 web 端 TermScreen 忠实渲染，由 toModelText() 在给模型时再做清理。
 * @param raw 捕获窗口原始输出（含哨兵）
 * @param sentinel 本次注入的哨兵串
 * @returns 剔除注入痕迹后的原始字节流（哨兵处可能残留空行，属正常）
 */
export function stripSentinel(raw: string, sentinel: string): string {
  // 命令回显尾部片段：旧 `; echo <哨兵>` 与新 `; printf '\n<哨兵>\n'` 两种注入格式，
  // 分号、命令词内/词间、哨兵字符间隙均可插 ANSI 或空白
  const TAIL_ECHO = new RegExp(`;${GAP}${interleave("echo")}${GAP}${interleave(sentinel)}${GAP}`, "g")
  const TAIL_PRINTF = new RegExp(
    `;${GAP}${interleave("printf")}${GAP}${interleave("'")}${GAP}(?:${interleave("\\n")})?${GAP}${interleave(sentinel)}${GAP}(?:${interleave("\\n")})?${GAP}${interleave("'")}`,
    "g",
  )
  // 哨兵独立成行：行首（或换行后）→ 哨兵 → 行尾换行，整行连同其换行删除（保留前置换行，避免行粘连）
  const STANDALONE = new RegExp(`(^|[\\r\\n])${GAP}${interleave(sentinel)}${GAP}\\r?\\n`, "gm")
  return raw.replace(TAIL_ECHO, "").replace(TAIL_PRINTF, "").replace(STANDALONE, (_m, lead: string) => lead)
}

/**
 * 剥离"提示符 + 命令回显"，只保留程序纯输出：
 * shell 提示符（含背景填充、zle 重绘序列）依赖其自身终端屏幕状态，字节流脱离该状态无法忠实还原，
 * 故丢弃窗口开头到"命令回显行结束"之前的一切内容（提示符、PS1 填充、光标定位噪音均在内）。
 * 命令回显行 = 命令文本首次出现所在行（命令本身可能含 \033 等转义）。
 * 三阶段定位：精确文本 → WIDE 正则（容忍 ANSI 间隙）→ 规范化（\033→ESC 后剥离 ANSI 匹配）。
 * @param raw 已剔除哨兵注入的原始字节流（stripSentinel 输出，哨兵行已删）
 * @param command 本次执行的命令文本
 * @returns 纯程序输出原始流（保留程序自身的 ANSI 颜色/进度条，供 web TermScreen 与模型 toModelText）
 */
export function extractOutput(raw: string, command: string): string {
  const cmd = command.trim()
  if (!cmd) return raw

  // 单条宽松正则一次性匹配命令回显（命令文本 + 字符间 ANSI 间隙）：
  // 1) 字符间容忍 ANSI 间隙（WIDE）2) 命令字面 \033 回显可能变真实 ESC（二选一）
  // 命中后切到"命令文本结束处"：zsh 下程序输出可能直接粘连在回显尾（无换行），不能按换行截断
  const WIDE = "(?:\\x1b\\[[0-9;?]*[a-zA-Z]|\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)|\\x1b[^\\x1b]|[ \\t])*"
  const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const norm = cmd.replace(/\\033/gi, "\x1b")
  const frags = [...norm].map((c) => (c === "\x1b" ? "(?:\\x1b|\\\\033)" : escRe(c)))
  const re = new RegExp(frags.join(WIDE), "g")
  const m = re.exec(raw)
  if (!m) return raw
  const end = m.index + m[0].length
  return raw.slice(end).replace(/^[\r\n]+/, "")
}

/**
 * 把原始终端流转为给模型看的干净文本：模拟终端屏幕（处理光标移动/清行/覆盖/退格/SGR/OSC），
 * 输出最终屏幕各行文本，再逐行去尾空白并剔除空行。比纯文本正则更鲁棒地处理 PSReadLine
 * 行内重绘、进度条 \r 覆盖等场景。
 * @param raw 已剔除哨兵的原始字节流（stripSentinel 输出）
 * @returns 纯文本输出（供模型消费 / exec 返回值 / read 命令）
 */
export function toModelText(raw: string): string {
  const screen = simulateScreen(raw)
  // 移除残留哨兵注入痕迹（PSReadLine 光标重绘后可能残留在未覆盖区域）：
  // `; echo __SSH_DONE_xxx` 或裸 `__SSH_DONE_xxx` 一并清除
  const noSentinel = screen.replace(/(?:;\s*echo\s+)?__SSH_DONE_[0-9a-f]*/gi, "")
  return noSentinel
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
      // 其他 ESC 序列（如 ESC 7/8 保存/恢复光标）：忽略
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
 * 剥离尾部 shell 提示符残留（如 "5cb08b77db01:~$ "、"user@host:~/dir$ "、"root@server:/etc#"）
 * @param s 清洗后文本
 * @returns 剥离尾部提示符后的文本
 */
export function stripPrompt(s: string): string {
  return s
    .replace(/(?:^|[\r\n])\s*(?:[\w.-]+@)?[\w.-]+:[^\r\n]*[$#%] ?(?=[\r\n]|$)/g, "")
    .trim()
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
