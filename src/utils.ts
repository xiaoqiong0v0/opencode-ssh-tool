// 工具函数：命令回显定位、模型文本清理、ANSI 清洗、CR 覆盖合并、完成标记剥离

import headless from "@xterm/headless"
import type { Terminal as HeadlessTerminal } from "@xterm/headless"

import { ANSI_SEQ_PATTERN, stripAnsi } from "./ansi.js"
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
const ECHO_WIDE = `(?:${ANSI_SEQ_PATTERN}|[ \\t\\r\\n])*`

/** 行尾 ANSI 容忍串（命令回显行尾可能残留光标定位/模式序列），与 ECHO_WIDE 共用同一模式源 */
const TAIL_ANSI = `(?:${ANSI_SEQ_PATTERN})*`

/** 回显行尾模式：容忍 \r 后跟 ANSI（如 bracketed paste off \x1b[?2004l）再换行，或直接 \n/字符串末尾 */
const LINE_END = "(?:(?:\\r?" + TAIL_ANSI + ")\\r?\\n|\\r?$)"

/** 段间匹配：容忍任意行（prompt、输出行等）直到下一段命令，再用 ECHO_WIDE 收紧命令字符间隙 */
const ECHO_BETWEEN = "[\\s\\S]*?"

/**
 * 生成"单行命令回显"的逐字符宽松模式：
 * 字符间容忍 ANSI/空白间隙，并在折行处容忍 readline 重复前一个字符
 * （超宽命令回显会多出边界字符，如 `...libayatan\r\n\x1b[39;120Hna-...`，精确匹配会失败）。
 * @param line 单行命令回显文本
 * @returns 该行的宽松匹配模式片段
 */
function echoLinePattern(line: string): string {
  const frags = [...line].map((c) => (c === "\x1b" ? "(?:\\x1b|\\\\033)" : escRe(c)))
  const gap = (prev: string): string => ECHO_WIDE + "(?:\\r?\\n" + TAIL_ANSI + prev + ECHO_WIDE + ")?"
  let out = frags[0] ?? ""
  for (let i = 1; i < frags.length; i++) out += gap(frags[i - 1]) + frags[i]
  return out + TAIL_ANSI + "[^\\r\\n]*"
}

/**
 * 回显正则的命令长度阈值（字符）：逐字符插 gap 会让模式源长约 265×命令长度——
 * 4434 字符命令会生成约 1.1MB 模式，在 JavaScriptCore（opencode 运行时）下 `new RegExp` 直接抛
 * "Invalid regular expression: regular expression too large"（V8 尚可容忍）。超过此阈值即降级。
 * 取 512：全量模式源约 136KB，远低于已知 JSC 可接受的量级（814 字符命令→215KB 实测可用）。
 */
export const ECHO_REGEX_MAX_CMD_CHARS = 512

/** 降级时首/尾各取的锚点字符数（够区分且模式源约 265×2×64≈34KB） */
const ECHO_ANCHOR_CHARS = 64

/**
 * 逐字符宽松正则的**输入扫描上界**（字符）：该正则的字符间间隙量词可嵌套
 * （`(?:ANSI|空白)*` 叠加折行容忍），在长且不匹配的输入上会发生灾难性回溯
 * （实测脏窗口 14KB 上 >15s；8KB 上 57ms 返回）。
 * 由于回显总在窗口起点附近、且下方压缩线性匹配已先行处理常规场景，正则路径只需扫描有界前缀。
 */
const ECHO_SCAN_BOUND = 8192

/**
 * 构建"去 ANSI + 压空白"的线性回显定位所需结构：
 * 逐字符保留可见字符，跳过 ANSI 转义序列与所有空白，并记录每个保留字符在原文中的偏移。
 * 用途：长命令回显常被 ConPTY 折行（插入 `\r\n`）与语法高亮（字符间插 ANSI）切碎，
 * 压缩后两端恢复成**连续可见文本**，可用 indexOf 线性定位（免疫逐字符间隙正则的病态回溯）。
 * @param s 原文（可含 ANSI 与换行）
 * @returns text=压缩后的连续文本；idx[k]=text[k] 在原文中的偏移
 */
function compressForEcho(s: string): { text: string; idx: number[] } {
  const re = new RegExp(ANSI_SEQ_PATTERN, "y")
  const chars: string[] = []
  const idx: number[] = []
  let i = 0
  while (i < s.length) {
    re.lastIndex = i
    const m = re.exec(s)
    if (m && m.index === i && m[0].length > 0) {
      i = re.lastIndex
      continue
    }
    const c = s[i]
    if (!/\s/.test(c)) {
      chars.push(c)
      idx.push(i)
    }
    i++
  }
  return { text: chars.join(""), idx }
}

/**
 * 压缩线性定位：在"压空白+去 ANSI"后的文本里找命令回显，命中则返回其在**原文**中结束后的偏移。
 * 作为 `extractOutputStart` 的首选快速路径（线性、无回溯），覆盖折行/高亮切碎的常规回显；
 * 被重绘**重复字符**插入（readline 边界重画）破坏连续性的场景会未命中，交由后续有界正则/标记边界兜底。
 * @param raw 原始终端流（含 ANSI）
 * @param command 本次执行的命令文本（与 echo 定位同源）
 * @param endBound 搜索上界（不含；末次匹配不得越过）
 * @param first true 取首次匹配（语法错误路径），false 取 endBound 前最后一次
 * @returns 命中：回显末尾在原文中的偏移（>0）；未命中：-1
 */
function compressedEchoEnd(raw: string, command: string, endBound: number, first: boolean): number {
  const cmd = command.trim()
  if (!cmd) return -1
  const echo = compressForEcho(cmd.replace(/\\033/gi, "\x1b")).text
  if (!echo) return -1
  const { text: body, idx } = compressForEcho(raw)
  // 允许的匹配结束位置上界（压缩坐标，不含）：endBound 之前最后一个保留字符的下一个位置
  const hiIdx = idx.findIndex((p) => p >= endBound)
  const limit = hiIdx < 0 ? idx.length : hiIdx
  if (first) {
    const start = body.indexOf(echo)
    return start >= 0 && start + echo.length <= limit ? idx[start + echo.length - 1] + 1 : -1
  }
  let start = body.lastIndexOf(echo)
  while (start >= 0 && start + echo.length > limit) start = body.lastIndexOf(echo, start - 1)
  return start >= 0 ? idx[start + echo.length - 1] + 1 : -1
}

/**
 * 构造命令回显匹配的正则模式源。命令较短时用逐字符宽松模式（容忍折行/ANSI）；
 * 超过 ECHO_REGEX_MAX_CMD_CHARS 时降级为"首/尾各 ECHO_ANCHOR_CHARS 个字符"的锚点，
 * 中间用 ECHO_BETWEEN 连通，避免模式源随命令长度线性膨胀（正则源有界，防运行时正则上限）。
 * @param norm 规范化后的命令回显文本（`\033` 已还原为真实 ESC）
 * @param forceFull true 强制走全量模式（仅供 echoRegexSourceLength 计算诊断长度）
 * @returns 正则模式源字符串
 */
function buildEchoPattern(norm: string, forceFull = false): string {
  // 单条宽松正则一次性匹配命令回显（支持多行命令）：
  // 1) 命令字符间容忍 ANSI 间隙（ECHO_WIDE）
  // 2) 命令字面 \033 回显可能变真实 ESC（二选一）
  // 3) 每段命令文本后允许任意行内字符直到行尾（[^\r\n]*），兼容追加的完成标记命令
  // 4) 多行命令：bash 逐行回显，行间可能夹 prompt 文本与 ANSI，用宽松段间匹配连接
  if (forceFull || norm.length <= ECHO_REGEX_MAX_CMD_CHARS) {
    return norm.split("\n").map(echoLinePattern).join(ECHO_BETWEEN + ECHO_WIDE) + "(?:" + LINE_END + ")"
  }
  // 超长降级：只逐字符宽松匹配首/尾定长锚点，中间用 [\s\S]*? 兜住（省掉中段的 ~265×N 模式膨胀）
  const head = echoLinePattern(norm.slice(0, ECHO_ANCHOR_CHARS))
  const tail = echoLinePattern(norm.slice(-ECHO_ANCHOR_CHARS))
  return head + ECHO_BETWEEN + ECHO_WIDE + tail + "(?:" + LINE_END + ")"
}

/**
 * 计算"未降级时的逐字符回显正则"模式源长度，供诊断日志展示（超长命令可直观看到 265×长度 的膨胀）。
 * @param command 命令回显文本（extractOutputStart 的第二入参）
 * @returns 正则模式源长度（字符）；空命令返回 0
 */
export function echoRegexSourceLength(command: string): number {
  const norm = command.trim().replace(/\\033/gi, "\x1b")
  return norm ? buildEchoPattern(norm, true).length : 0
}

/**
 * 定位命令回显行在原始流中的结束位置（供流式增量定位使用）：
 * 丢弃窗口开头到"命令回显行结束"之前的一切内容——**靠命令文本自锚定，不判断提示符形态**；
 * 提示符 / PS1 填充 / 光标定位噪音都随这段前缀被一并丢弃（无需识别其长什么样）。
 * 命令回显行 = 命令文本首次出现所在行（命令本身可能含 \033 等转义）。
 * 命令文本后允许任意行内字符直到行尾：命令可能被追加完成标记（如 `cmd ;printf '<SSH_DONE…>'`），
 * 此时回显是整行拼接，不能要求命令后紧跟换行。
 * 超长命令自动降级为模式源有界的锚点匹配（见 buildEchoPattern / ECHO_REGEX_MAX_CMD_CHARS）；
 * `new RegExp` 若仍失败（运行时正则上限）返回 -1，由调用方按"未定位"退回整窗，绝不向上抛。
 * @param raw 原始终端流（含 ANSI）
 * @param command 本次执行的命令文本
 * @param endBound 搜索上界（不含），默认窗口末尾；末次匹配模式下用于避免后续裸命令回显把定位带偏
 * @param first true 取窗口内**首次**匹配（语法错误路径：错误块会重印含标记的整行命令，
 *              末次匹配会落到错误块内的命令拷贝上，导致错误块前半被裁掉）
 * @returns 命令回显结束后的字节偏移（命中必 > 0）；未命中/正则失败返回 -1（调用方按 `<= 0` 判定"未定位"）
 */
export function extractOutputStart(raw: string, command: string, endBound = raw.length, first = false): number {
  const cmd = command.trim()
  if (!cmd) return -1
  // 首选：压缩线性定位（去 ANSI + 压空白后 indexOf）——线性、无回溯，覆盖折行/高亮切碎的常规回显
  const linear = compressedEchoEnd(raw, command, endBound, first)
  if (linear > 0) return linear
  // 兜底：逐字符宽松正则（容忍 readline 边界重绘的重复字符），但**只扫描有界前缀**，
  // 避免长且不匹配的输入触发灾难性回溯（见 ECHO_SCAN_BOUND）。压缩失败通常意味着窗口仍含重绘杂物，
  // 此时真正可靠的是调用方的"按标记边界裁剪"兜底，此处仅再试一次即止。
  const scanEnd = Math.min(endBound, raw.length, ECHO_SCAN_BOUND)
  if (scanEnd <= 0) return -1
  const scanned = raw.length > scanEnd ? raw.slice(0, scanEnd) : raw
  const norm = cmd.replace(/\\033/gi, "\x1b")
  let re: RegExp
  try {
    re = new RegExp(buildEchoPattern(norm), "g")
  } catch {
    // 正则过大/非法（如 JSC 对超大模式抛 "regular expression too large"）：视作"未定位"，不向上抛
    return -1
  }
  if (first) {
    const m = re.exec(scanned)
    return m && m.index < scanEnd ? m.index + m[0].length : -1
  }
  // 取 [0, scanEnd) 范围内最后一次匹配：备屏退出（如 cmatrix）会重放主屏历史，
  // 其中含旧命令回显，只有最后一次出现的回显之后才是本次命令的真实输出；
  // scanEnd 限到完成标记之前，避免连续输入时后续裸命令回显把定位带偏
  return findLastEndOfBefore(re, scanned, 0, scanEnd)
}

/**
 * 剥离"命令回显前缀"（含提示符 / PS1 填充 / 光标噪音），只保留程序纯输出：
 * **靠命令文本自锚定，不判断提示符形态**（提示符依赖终端自身屏幕状态、且形态可变，不可识别），
 * 故丢弃窗口开头到"命令回显行结束"之前的一切内容——前缀里的提示符/填充/噪音随之一并丢弃。
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
 * 行归一化：剥 ANSI、去行尾 \r 与尾空白。
 * 只服务"探针回显前缀是否还有可见字符"的**存在性**判断（与 `""` 比较），
 * 不再作提示符相等基准——提示符形态随 cwd/profile/主题变化，不可判断。
 */
const normLine = (s: string): string => stripAnsi(s).replace(/\r$/, "").trimEnd()

/**
 * 探针回显"单个匹配区间的跨度上限"（字符，含字符间插入的 ANSI 与空白）。
 * 探针命令本身约 50 可见字符、pwsh 语法高亮插入的 SGR 约 20 → 正常跨度约 70；取 200 留足余量。
 * 超限视作宽松匹配的误命中（如稀疏空白把命令字符拉开），不删——宁可留脏，不可误删。
 */
export const PROBE_ECHO_MAX_SPAN = 200

/**
 * ANSI 容忍定位 needle 在 text 中的**首次**出现：允许 needle 字符之间插入 ANSI 转义序列与任意空白
 * （复用"去 ANSI + 压空白"的线性匹配，免疫 shell 语法高亮在 token 间插入的 SGR）。
 * 绝不用提示符做锚点（提示符随 cwd/profile/主题变化，不可锚定）。
 * @param text 待搜索文本（调用方按行传入）
 * @param needle 待定位文本（探针命令，含会话 nonce，天然唯一）
 * @returns 命中：{start,end}（相对 text 原文偏移，end 为末个可见字符后一位）；未命中：null
 */
export function findAnsiTolerantFirstRange(text: string, needle: string): { start: number; end: number } | null {
  const target = compressForEcho(needle.replace(/\\033/gi, "\x1b")).text
  if (!target) return null
  const { text: body, idx } = compressForEcho(text)
  const i = body.indexOf(target)
  if (i < 0) return null
  return { start: idx[i], end: idx[i + target.length - 1] + 1 }
}

/**
 * 判定探针回显前缀是否已无任何可见字符（D1 判据）：该行删掉探针回显后若只剩空白/ANSI 前缀，
 * 说明**探针回显是本行首个可见 token** → 整行丢弃。
 * 只做存在性判断，不与任何提示符基准比较（提示符形态随 cwd/profile/主题变化，不可判断）；
 * 前缀含可见字符则保留（行中打断场景下前缀可能是真输出，宁可留脏，不可误删）。
 * @param head 探针回显起点之前的行前缀（已回退掉紧邻 ANSI）
 * @returns true 表示前缀无任何可见字符
 */
function hasNoVisiblePrefix(head: string): boolean {
  return normLine(head) === ""
}

/**
 * 行尾锚定的 ANSI 序列匹配：用于把删除起点**向前回退到紧邻的 ANSI 之前**。
 * 只回退 ANSI 字节（不越过任何可见字符/提示符/真输出），使探针首 token 前的语法高亮色码
 * 随回显一起删除，避免行中打断场景残留孤立色码污染后续输出。
 */
const ANSI_AT_END = new RegExp(`(?:${ANSI_SEQ_PATTERN})$`)

/**
 * 把位置 pos 向前回退，跳过紧邻其前的连续 ANSI 序列（不含可见字符）。
 * @param line 行文本
 * @param pos 起始位置
 * @returns 回退后的位置（≥0）
 */
function backOverAnsi(line: string, pos: number): number {
  let cut = pos
  for (;;) {
    const m = line.slice(0, cut).match(ANSI_AT_END)
    if (!m || m[0].length === 0) break
    cut -= m[0].length
  }
  return cut
}

/**
 * 剔除探针命令回显行（含 shell 语法高亮插入的 ANSI 与提示符前缀）：
 * 逐行处理，对每行 ANSI 容忍地定位任一 needle 的首次出现；命中且跨度不超 PROBE_ECHO_MAX_SPAN 时，
 * 删除「探针回显起点（含其前紧邻 ANSI 色码）→ 该行行尾」——**只向后删、绝不向前越过可见字符**：
 * 保留行中探针之前的真输出（行中打断场景）；若探针回显即本行首个可见 token（前缀无可见字符）则整行丢弃，
 * 否则保留其前缀（可能是真输出，也可能是提示符，不再与提示符基准比较）。
 * 无命中行逐字节不变；Raw 视图不经此函数，保留原始字节。
 * @param text 可见输出文本
 * @param needles 探针命令文本（各 seq；含会话 nonce，故不会命中别的会话/nonce 的探针）
 * @returns 剔除后文本
 */
export function removeProbeEchoLines(text: string, needles: string[]): string {
  if (needles.length === 0 || text === "") return text
  const kept: string[] = []
  for (const line of text.split("\n")) {
    // 取本行内最早出现的探针回显起点（多个 needle 时取最小 start）
    let cut = -1
    for (const needle of needles) {
      const r = findAnsiTolerantFirstRange(line, needle)
      if (!r) continue
      if (r.end - r.start > PROBE_ECHO_MAX_SPAN) continue // 护栏②：跨度超限，疑误命中，不删
      if (cut < 0 || r.start < cut) cut = r.start
    }
    if (cut < 0) {
      kept.push(line) // 无命中：逐字节保留
      continue
    }
    const head = line.slice(0, backOverAnsi(line, cut)) // 护栏③：只删探针起点→行尾，保留该行前半真输出
    if (hasNoVisiblePrefix(head)) continue // D1：探针回显即本行首个可见 token → 整行丢弃
    kept.push(head)
  }
  return kept.join("\n")
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
 * 时间戳格式化为 yyyy-MM-dd HH:mm:ss
 * @param ts 毫秒时间戳
 * @returns 格式化时间
 */
export function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
