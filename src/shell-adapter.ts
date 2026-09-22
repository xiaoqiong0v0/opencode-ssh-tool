// Shell 适配器：Shell 类型探测 + 完成标记命令（每条命令后追加）
// 标记格式：<SSH_DONE:<退出码>>  —— 可见文本便于 web Raw 模式直接调试；
// 展示给用户/模型的输出会在上层剥离标记（用户实际看不到，与不可见标记等效）。
// 完成判定不再依赖 prompt 钩子（PROMPT_COMMAND/PS1/prompt 函数——会被 oh-my-posh/p10k 覆盖），
// 改为在每条命令后追加独立一行的标记输出命令，免疫任何提示符框架。

import { DONE_TAG, SHELL_ID_PREFIX } from "./constants.js"
import { findLastMatch } from "./last-match.js"

/** Shell 适配器接口 */
export interface ShellAdapter {
  readonly name: string
  readonly probeCommand: string
  /**
   * 语句分隔符：把完成标记拼到命令/组尾用。
   * POSIX 系（zsh/bash）与 pwsh 为 `;`；cmd 的 `;` 不是分隔符，须用 `&`。
   */
  readonly stmtSep: string
  parseProbe(output: string): boolean
  /** 每条命令后追加的完成标记命令（seq 为命令序号，独立一行执行） */
  markerCmd(seq: number): string
  /**
   * 多行命令的组包裹：把多行命令包成**一条**命令（一次输入 = 一条命令 = 一段输出），
   * 避免 shell 逐行执行导致回显与输出交错、中间输出在提取时丢失；heredoc 分隔符行必须独占一行，
   * 故含 heredoc 的多行命令也必须包组。包裹须保留当前作用域（zsh/bash 用 `{ }`，
   * pwsh 用点源 `. { }`，不可用 `& { }`——那是子作用域会丢变量/状态）。
   * @param body 多行命令体（已剥离尾注释/尾运算符）
   * @returns 包裹后的命令文本；返回 null 表示该 shell 无法安全包组（cmd 组内 `%errorlevel%` 为解析期展开，退出码会失真）
   */
  groupWrap(body: string): string | null
  /**
   * 命令是否会让 shell 进入续行等待（未闭合引号/反引号、行尾续行符等）。
   * 命中时追加的完成标记不会执行（被当续行内容）→ 检测不到完成、busy 卡死，故提交前拦截。
   * 各 shell 语义不同：POSIX 反引号为命令替换定界符；pwsh 反引号为转义/续行符；cmd 用 `^`。
   * @param command 命令文本
   * @returns true 表示 shell 会等待续行
   */
  hasOpenContinuation(command: string): boolean
}

// ===== 完成标记检测（在原始字节流中定位/剥离 <SSH_DONE:seq:退出码>） =====

/** 匹配任意完成标记（含序号式 <SSH_DONE:seq:code> 与无序号 <SSH_DONE:code>，退出码在末尾）；前缀取自 DONE_TAG，< 与 : 在正则中均为字面量 */
const DONE_RE = new RegExp(DONE_TAG + "(?:\\d+:)?(-?\\d+)>", "g")

/** 检测指定序号命令的完成标记 */
function doneSeqRe(seq: number): RegExp {
  return new RegExp(`${DONE_TAG}${seq}:(-?\\d+)>`, "g")
}

/** 终端中断回显：Ctrl-C 由 TTY 层回显为 ^C（ECHOCTL 开启），与 shell 框架无关 */
const INTERRUPT_ECHO = "^C"

/**
 * 判断命令是否完成：检测指定序号 <SSH_DONE:seq:<码>> 的完成标记（只认当前命令，防残留误判）
 * @param buffer 原始字节流
 * @param fromPos 搜索起点
 * @param seq 当前命令序号
 */
export function detectLastDoneMarker(buffer: string, fromPos: number, seq: number): { done: boolean; exitCode: number; pos: number } {
  const m = findLastMatch(doneSeqRe(seq), buffer, fromPos)
  if (!m) return { done: false, exitCode: 0, pos: 0 }
  return { done: true, exitCode: parseInt(m[1], 10) || 0, pos: m.index + m[0].length }
}

export function stripMarkers(raw: string): string {
  return raw.replace(DONE_RE, "")
}

/** 检测从指定位置起是否出现中断回显 ^C（命令被 Ctrl-C 中断） */
export function detectInterrupt(buffer: string, fromPos: number): { interrupted: boolean; pos: number } {
  const idx = buffer.indexOf(INTERRUPT_ECHO, fromPos)
  return { interrupted: idx >= 0, pos: idx >= 0 ? idx : 0 }
}

// ===== Shell 类型探测与标记命令 =====

/**
 * 提取 POSIX heredoc 分隔符（`<<EOF` / `<<-EOF` / `<<'EOF'` / `<<"EOF"`），无则返回 null。
 * 逐字符扫描并跟踪 `'`/`"` 引号状态，只对引号外的 `<<` 尝试匹配分隔符；
 * 避免 `echo "a << b"`、`grep '<<EOF' file` 这类引号内的 `<<` 被误判为 heredoc 起始。
 * @param line 当前行文本
 * @returns 引号外首个合法 heredoc 的分隔符；不存在则 null
 */
function heredocDelim(line: string): string | null {
  let inSingle = false
  let inDouble = false
  let escaped = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (escaped) { escaped = false; continue }
    if (c === "\\" && !inSingle) { escaped = true; continue }
    if (c === "'" && !inDouble) { inSingle = !inSingle; continue }
    if (c === '"' && !inSingle) { inDouble = !inDouble; continue }
    if (inSingle || inDouble) continue
    // 引号外发现 `<<`：从其后匹配 <<-?\s*(['"]?)([A-Za-z_]\w*)\1
    if (c === "<" && line[i + 1] === "<") {
      const m = line.slice(i + 2).match(/^-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/)
      if (m) return m[2]
    }
  }
  return null
}

/**
 * 判断行内位置 i 的 `#` 是否构成 POSIX 注释起始（词首）。
 * 仅当 `#` 处于文本开头、或前一字符为空白 / `;` `&` `|` `(` `)` `<` `>` 之一时为注释；
 * `$#`（前为 `$`）、`a#b`（前为普通字符）与 `${x}#foo`（前为 `}`，属词内）均非注释。
 * @param line 当前行文本
 * @param i `#` 所在下标
 * @returns true 表示该 `#` 起至行尾为注释
 */
function isPosixCommentStart(line: string, i: number): boolean {
  if (i === 0) return true
  const p = line[i - 1]
  return /\s/.test(p) || p === ";" || p === "&" || p === "|" || p === "(" || p === ")" || p === "<" || p === ">"
}

/**
 * POSIX（bash/zsh/sh）续行检测：未闭合的单/双引号或反引号（命令替换）、行尾未转义反斜杠、
 * 未闭合的 heredoc、以及未闭合的 `(`/`{` 组。
 * 单引号内反斜杠为字面量；双引号/反引号内反斜杠转义下一个字符。
 * 逐行扫描：heredoc 正文行（分隔符行之间的内容）与注释（词首 `#` 起至行尾）整段跳过，
 * 不参与引号/深度配对，否则正文里的 `don't` 等会被误判为未闭合而拒绝命令。
 * 深度用「> 0」而非「≠ 0」判断，以兼容 `case` 语句 `a)` 臂产生的负括号深度。
 * @param s 命令文本
 * @returns true 表示 shell 会等待续行
 */
function posixOpenContinuation(s: string): boolean {
  let inSingle = false
  let inDouble = false
  let inBacktick = false
  let parenDepth = 0
  let braceDepth = 0
  let pendingHeredoc: string | null = null
  let lineContinuation = false
  for (const line of s.split("\n")) {
    // heredoc 正文行：整行跳过，不参与引号/深度配对；遇分隔符行则闭合
    if (pendingHeredoc !== null) {
      if (line.trim() === pendingHeredoc) pendingHeredoc = null
      continue
    }
    let escaped = false
    lineContinuation = false
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (escaped) { escaped = false; continue }
      if (c === "\\" && !inSingle) { escaped = true; continue }
      if (c === "'" && !inDouble && !inBacktick) { inSingle = !inSingle; continue }
      if (c === '"' && !inSingle) { inDouble = !inDouble; continue }
      if (c === "`" && !inSingle) { inBacktick = !inBacktick; continue }
      if (inSingle || inDouble || inBacktick) continue
      // 注释：词首 `#` 起至行尾跳过（注释里的引号不影响配对）
      if (c === "#" && isPosixCommentStart(line, i)) break
      if (c === "(") parenDepth++
      else if (c === ")") parenDepth--
      else if (c === "{") braceDepth++
      else if (c === "}") braceDepth--
    }
    // 行尾未转义反斜杠 = 续行（下一行首字符不被转义，故 escaped 不跨行）
    if (escaped) lineContinuation = true
    // 引号外检测本行 heredoc 起始（`<<EOF` 等）
    if (!inSingle && !inDouble && !inBacktick) {
      const d = heredocDelim(line)
      if (d) pendingHeredoc = d
    }
  }
  return inSingle || inDouble || inBacktick || lineContinuation || pendingHeredoc !== null || parenDepth > 0 || braceDepth > 0
}

/**
 * 判断 pwsh 行是否以 here-string 起始标记结尾，返回对应闭合标记（`"@` 或 `'@`）或 null。
 * 引号感知扫描：仅当行尾（去尾空白后）为 `@"` 或 `@'`、且该 `@` 处于引号外、并位于词首
 * （前一字符为文本开头 / 空白 / `=` / `(` / `,` / `|`）时才算起始。
 * 避免 `Write-Output "foo@"` 这类引号内/词内的 `@"` 被误判为 here-string 起始。
 * @param line 当前行文本
 * @returns 该起始标记对应的闭合标记（`"@` 对应 `@"`，`'@` 对应 `@'`）；非起始则 null
 */
function pwshHereStringStart(line: string): string | null {
  const trimmed = line.trimEnd()
  const n = trimmed.length
  if (n < 2 || trimmed[n - 2] !== "@") return null
  const quote = trimmed[n - 1]
  if (quote !== '"' && quote !== "'") return null
  // 词首判定：`@` 前一字符须为 文本开头/空白/=/(/,/|
  const prev = n >= 3 ? trimmed[n - 3] : ""
  if (!(prev === "" || /\s/.test(prev) || prev === "=" || prev === "(" || prev === "," || prev === "|")) return null
  // 引号感知扫描 `@` 之前的部分：反引号转义下一字符，判断 `@` 处是否在引号外
  let inSingle = false
  let inDouble = false
  let escaped = false
  for (let i = 0; i < n - 2; i++) {
    const c = trimmed[i]
    if (escaped) { escaped = false; continue }
    if (c === "`") { escaped = true; continue }
    if (c === "'" && !inDouble) { inSingle = !inSingle; continue }
    if (c === '"' && !inSingle) { inDouble = !inDouble; continue }
  }
  if (inSingle || inDouble) return null
  return quote + "@"
}

/**
 * PowerShell 续行检测：未闭合单/双引号、行尾反引号（转义/续行）、行尾管道 `|`、
 * 未闭合的 here-string（`@"`…`"@` / `@'`…`'@`）、以及未闭合的 `{`/`(` 组。
 * 反引号转义下一个字符；单引号内不转义。here-string 正文内的引号/花括号/圆括号不参与配对。
 * @param s 命令文本
 * @returns true 表示 shell 会等待续行
 */
function pwshOpenContinuation(s: string): boolean {
  let inSingle = false
  let inDouble = false
  let parenDepth = 0
  let braceDepth = 0
  let hereClose: string | null = null
  let lineContinuation = false
  const lines = s.split("\n")
  for (const line of lines) {
    // here-string 正文行：整行跳过；遇闭合行（以 "@ 或 '@ 结尾）则闭合
    if (hereClose !== null) {
      if (line.trim().endsWith(hereClose)) hereClose = null
      continue
    }
    // here-string 起始：行尾以 @" 或 @' 结束（须引号外且词首，见 pwshHereStringStart）；标记不参与引号配对
    let scanLine = line
    let opener: string | null = null
    if (!inSingle && !inDouble) {
      opener = pwshHereStringStart(line)
      if (opener !== null) scanLine = line.slice(0, line.trimEnd().length - 2)
    }
    let escaped = false
    lineContinuation = false
    for (let i = 0; i < scanLine.length; i++) {
      const c = scanLine[i]
      if (escaped) { escaped = false; continue }
      if (c === "`") { escaped = true; continue }
      if (c === "'" && !inDouble) { inSingle = !inSingle; continue }
      if (c === '"' && !inSingle) { inDouble = !inDouble; continue }
      if (inSingle || inDouble) continue
      if (c === "{") braceDepth++
      else if (c === "}") braceDepth--
      else if (c === "(") parenDepth++
      else if (c === ")") parenDepth--
    }
    // 行尾反引号 = 续行
    if (escaped) lineContinuation = true
    if (opener !== null) hereClose = opener
  }
  // 行尾管道 `|`：整段最后一行以 | 结尾 → 续行
  const trailingPipe = /\|\s*$/.test(lines[lines.length - 1] ?? "")
  return inSingle || inDouble || lineContinuation || trailingPipe || hereClose !== null || parenDepth > 0 || braceDepth > 0
}

/**
 * cmd.exe 续行检测：未闭合的 `(`/`)` 组（cmd 显示 `More?` 等待），或行尾脱字符 `^`（转义/续行）。
 * 注意 cmd 无双引号续行语义：未闭合双引号不代表等待输入，故不作为续行依据（避免合法命令被拒）。
 * @param s 命令文本
 * @returns true 表示 shell 会等待续行
 */
function cmdOpenContinuation(s: string): boolean {
  let inDouble = false
  let parenDepth = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === "^") { i++; continue } // ^ 转义下一个字符
    if (c === '"') { inDouble = !inDouble; continue }
    if (inDouble) continue
    if (c === "(") parenDepth++
    else if (c === ")") parenDepth--
  }
  return parenDepth > 0 || /\^\s*$/.test(s)
}

class ZshAdapter implements ShellAdapter {
  readonly name = "zsh"
  readonly probeCommand = `echo ${SHELL_ID_PREFIX}$0`
  readonly stmtSep = ";"
  markerCmd(seq: number): string {
    // 结尾补换行：否则 zsh 判定"上条输出未以换行结束"，会补印 PROMPT_EOL_MARK（root 为 #）污染画面
    return `printf '\\n${DONE_TAG}${seq}:%s>\\n' $?`
  }
  groupWrap(body: string): string | null {
    // `{ }` 命令组在当前作用域执行（保留 cd/变量）；未闭合的 `{` 会让 zsh 进入 PS2 续行，
    // 整段多行输入被当作一条命令解析
    return `{ ${body}\n}`
  }
  hasOpenContinuation(command: string): boolean {
    return posixOpenContinuation(command)
  }
  parseProbe(output: string): boolean {
    // login shell 的 $0 带 - 前缀（-zsh），须容忍
    return new RegExp(`${SHELL_ID_PREFIX}-?zsh|(?:^|\\W)zsh(?:\\W|$)`, "i").test(output)
  }
}

// ===== Bash 系（bash / sh） =====
class BashAdapter implements ShellAdapter {
  readonly name = "bash"
  readonly probeCommand = `echo ${SHELL_ID_PREFIX}$0`
  readonly stmtSep = ";"
  markerCmd(seq: number): string {
    // bash 无 PROMPT_EOL_MARK，标记无需补尾换行（补了反而在 raw 里多顶一行）
    return `printf '\\n${DONE_TAG}${seq}:%s>' $?`
  }
  groupWrap(body: string): string | null {
    // `{ }` 命令组在当前作用域执行（保留 cd/变量）；未闭合的 `{` 会让 bash 进入 PS2 续行
    return `{ ${body}\n}`
  }
  hasOpenContinuation(command: string): boolean {
    return posixOpenContinuation(command)
  }
  parseProbe(output: string): boolean {
    // login shell 的 $0 带 - 前缀（-bash），须容忍
    return new RegExp(`${SHELL_ID_PREFIX}-?(?:bash|sh)\\b|(?:^|\\W)(?:bash|sh)(?:\\W|$)`, "i").test(output)
  }
}

// ===== PowerShell =====
class PwshAdapter implements ShellAdapter {
  readonly name = "pwsh"
  readonly probeCommand = `Write-Output ${SHELL_ID_PREFIX}pwsh_$PSHOME`
  readonly stmtSep = ";"
  markerCmd(seq: number): string {
    // 用 Write-Output（success 管线）而非 Write-Host：Write-Host 直写 host 流会抢在
    // cmdlet 输出（经格式化器批量渲染）之前，导致 marker 落在命令输出之前、提取时把输出裁掉
    return `Write-Output "${DONE_TAG}${seq}:$LASTEXITCODE>"`
  }
  groupWrap(body: string): string | null {
    // 点源 `. { }` 在当前作用域执行（保留变量/状态）；不可用 `& { }`（子作用域会丢变量/状态）。
    // 未闭合的 `{` 会让 pwsh 进入续行，整段多行输入被当作一条命令解析
    return `. { ${body}\n}`
  }
  hasOpenContinuation(command: string): boolean {
    return pwshOpenContinuation(command)
  }
  parseProbe(output: string): boolean {
    // Write-Output __SHELL_ID__pwsh_$PSHOME → pwsh 展开为路径；cmd 下 $PSHOME 不被展开（字面保留 $），借此区分
    return /__SHELL_ID__pwsh_[^$]/.test(output)
  }
}

// ===== Windows cmd.exe =====
class CmdAdapter implements ShellAdapter {
  readonly name = "cmd"
  readonly probeCommand = `echo ${SHELL_ID_PREFIX}%COMSPEC%`
  readonly stmtSep = "&"
  markerCmd(seq: number): string {
    return `echo ${DONE_TAG}${seq}:%errorlevel%>`
  }
  groupWrap(_body: string): string | null {
    // cmd 不包组：组内 `%errorlevel%` 是解析期展开，退出码会失真；保持原样逐行执行
    return null
  }
  hasOpenContinuation(command: string): boolean {
    return cmdOpenContinuation(command)
  }
  parseProbe(output: string): boolean {
    // echo __SHELL_ID__%COMSPEC% → cmd 展开为 __SHELL_ID__C:\...cmd.exe（无 % 原样遗留即判为 cmd）
    return /__SHELL_ID__(?!%)\S*cmd\.exe/i.test(output)
  }
}

/** 注册表（探测顺序：先 POSIX 系，后 pwsh/cmd；resolveByProbe 由 _probeShell 改用各适配器 probeCommand 逐个探测） */
export const adapters: ShellAdapter[] = [
  new ZshAdapter(),
  new BashAdapter(),
  new PwshAdapter(),
  new CmdAdapter(),
]

/**
 * 根据探测结果选择适配器
 * @param probeOutput 探测命令的输出
 * @returns 匹配的适配器
 */
export function resolveByProbe(probeOutput: string): ShellAdapter {
  for (const a of adapters) {
    if (a.parseProbe(probeOutput)) return a
  }
  // 默认最后一个适配器兜底
  return adapters[adapters.length - 1]
}