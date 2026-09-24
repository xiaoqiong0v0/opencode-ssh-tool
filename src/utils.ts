// 工具函数：命令回显定位、模型文本清理、ANSI 清洗、CR 覆盖合并、完成标记剥离

import headless from "@xterm/headless"
import type { Terminal as HeadlessTerminal } from "@xterm/headless"

import { PTY_COLS, PTY_ROWS, TERM_SCROLLBACK_LINES } from "./constants.js"
import { findLastEndOfBefore } from "./last-match.js"
import { stripMarkers } from "./shell-adapter.js"

/** headless 终端构造器（@xterm/headless 为 CommonJS，Node ESM 无法静态识别其具名导出，故从默认导出解构） */
const { Terminal: TerminalCtor } = headless

/** headless 写入回调等待上限（毫秒）：超时按已解析内容读取，避免极端情况下永久挂起 */
const HEADLESS_WRITE_TIMEOUT_MS = 10_000

/** 正则转义文本 */
const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** 命令回显匹配的宽松字符间隙（ANSI 序列或普通空白/换行，可插在命令字符之间；容忍终端列宽自动换行） */
const ECHO_WIDE = "(?:\\x1b\\[[0-9;?]*[a-zA-Z]|\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)|\\x1b[^\\x1b]|[ \\t\\r\\n])*"

/**
 * 定位命令回显行在原始流中的结束位置（供流式增量定位使用）：
 * 丢弃窗口开头到"命令回显行结束"之前的一切内容（提示符、PS1 填充、光标定位噪音均在内）。
 * 命令回显行 = 命令文本首次出现所在行（命令本身可能含 \033 等转义）。
 * 命令文本后允许任意行内字符直到行尾：命令可能被追加完成标记（如 `cmd ;printf '<SSH_DONE…>'`），
 * 此时回显是整行拼接，不能要求命令后紧跟换行。
 * @param raw 原始终端流（含 ANSI）
 * @param command 本次执行的命令文本
 * @returns 命令回显结束后的字节偏移；未命中命令文本返回 0（此时应视作输出尚未开始）
 */
export function extractOutputStart(raw: string, command: string, endBound = raw.length): number {
  const cmd = command.trim()
  if (!cmd) return 0
  // 单条宽松正则一次性匹配命令回显（支持多行命令）：
  // 1) 命令字符间容忍 ANSI 间隙（ECHO_WIDE）
  // 2) 命令字面 \033 回显可能变真实 ESC（二选一）
  // 3) 每段命令文本后允许任意行内字符直到行尾（[^\r\n]*），兼容追加的完成标记命令
  // 4) 多行命令：bash 逐行回显，行间可能夹 prompt 文本与 ANSI，用宽松段间匹配连接
  const norm = cmd.replace(/\\033/gi, "\x1b")
  const TAIL_ANSI = "(?:\\x1b\\[[0-9;?]*[a-zA-Z]|\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)|\\x1b[^\\x1b])*"
  // 行尾：容忍 \r 后跟 ANSI（如 bracketed paste off \x1b[?2004l）再换行，或直接 \n/字符串末尾
  const LINE_END = "(?:(?:\\r?" + TAIL_ANSI + ")\\r?\\n|\\r?$)"
  const lineOf = (line: string): string => {
    const frags = [...line].map((c) => (c === "\x1b" ? "(?:\\x1b|\\\\033)" : escRe(c)))
    // 字符间隙：容忍 ANSI/空白；并容忍 readline 折行重绘在折行处**重复前一个字符**
    // （超宽命令回显会多出边界字符，如 `...libayatan\r\n\x1b[39;120Hna-...`，精确匹配会失败）
    const gap = (prev: string): string => ECHO_WIDE + "(?:\\r?\\n" + TAIL_ANSI + prev + ECHO_WIDE + ")?"
    let out = frags[0] ?? ""
    for (let i = 1; i < frags.length; i++) out += gap(frags[i - 1]) + frags[i]
    return out + TAIL_ANSI + "[^\\r\\n]*"
  }
  const lines = norm.split("\n")
  // 段间匹配：容忍任意行（prompt、输出行等）直到下一段命令，再用 ECHO_WIDE 收紧命令字符间隙
  const BETWEEN = "[\\s\\S]*?"
  const re = new RegExp(lines.map(lineOf).join(BETWEEN + ECHO_WIDE) + "(?:" + LINE_END + ")", "g")
  // 取 [0, endBound) 范围内最后一次匹配：备屏退出（如 cmatrix）会重放主屏历史，
  // 其中含旧命令回显，只有最后一次出现的回显之后才是本次命令的真实输出；
  // endBound 限到完成标记之前，避免连续输入时后续裸命令回显把定位带偏
  return findLastEndOfBefore(re, raw, 0, endBound)
}

/**
 * 剥离"提示符 + 命令回显"，只保留程序纯输出：
 * shell 提示符（含背景填充、zle 重绘序列）依赖其自身终端屏幕状态，字节流脱离该状态无法忠实还原，
 * 故丢弃窗口开头到"命令回显行结束"之前的一切内容（提示符、PS1 填充、光标定位噪音均在内）。
 * 命令回显行 = 命令文本首次出现所在行（命令本身可能含 \033 等转义）。
 * 命中后切到"命令文本结束处"：zsh 下程序输出可能直接粘连在回显尾（无换行），不能按换行截断。
 * @param raw 原始终端流（含 ANSI）
 * @param command 本次执行的命令文本
 * @returns 纯程序输出原始流（保留程序自身的 ANSI 颜色/进度条，供 web HeadlessScreen 与模型 toModelText）
 */
export function extractOutput(raw: string, command: string): string {
  const end = extractOutputStart(raw, command)
  if (end <= 0) return raw
  return raw.slice(end).replace(/^[\r\n]+/, "")
}

/**
 * 把原始终端流转为给模型看的干净文本：用 xterm headless 引擎忠实模拟终端屏幕
 * （处理光标移动/清行/清屏/覆盖/退格/SGR/OSC，含 scrollback），再逐行去尾空白并剔除空行。
 * 比纯文本正则更鲁棒地处理 PSReadLine 行内重绘、进度条 \r 覆盖等场景。
 * @param raw 原始终端流（含 ANSI）
 * @returns Promise：纯文本输出（供模型消费 / exec 返回值 / read 命令）；write 为异步，故返回 Promise
 */
export async function toModelText(raw: string): Promise<string> {
  const term = createHeadlessTerminal()
  try {
    await writeHeadless(term, stripMarkers(raw))
    const buf = term.buffer.active
    const lines: string[] = []
    // 从最早仍保留的行（含 scrollback）读到末行；行尾去尾空白、保留行内空白
    for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "")
    return lines
      .map((l) => l.replace(/\r/g, "").trimEnd())
      .filter((l) => l !== "")
      .join("\n")
  } finally {
    term.dispose()
  }
}

/**
 * 建一个 headless 终端：固定 PTY 尺寸 + scrollback，并开启 proposed API（访问 term.buffer 必需）
 * @returns 新的 headless Terminal 实例
 */
function createHeadlessTerminal(): HeadlessTerminal {
  return new TerminalCtor({
    cols: PTY_COLS,
    rows: PTY_ROWS,
    scrollback: TERM_SCROLLBACK_LINES,
    allowProposedApi: true,
  })
}

/**
 * 向 headless 终端写入并等待解析完成：write 回调触发即兑现，超过超时上限（极端情况守卫）亦兑现
 * @param term headless 终端
 * @param data 待写入的原始流（含 ANSI）
 * @returns Promise：解析完成（或超时）后兑现
 */
function writeHeadless(term: HeadlessTerminal, data: string): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    const timer = setTimeout(done, HEADLESS_WRITE_TIMEOUT_MS)
    term.write(data, () => {
      clearTimeout(timer)
      done()
    })
  })
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
