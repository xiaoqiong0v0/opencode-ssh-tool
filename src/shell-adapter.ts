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
  parseProbe(output: string): boolean
  /** 每条命令后追加的完成标记命令（seq 为命令序号，独立一行执行） */
  markerCmd(seq: number): string
  /**
   * 将用户提交的多行命令按本 shell 的行续行规则拆分为独立命令：
   * 行尾带续行符（bash/sh/zsh 的 `\`，pwsh 的 `|`/反引号/未闭合花括号）时与下一行合并，
   * 其余行各自独立成命令；空行/纯空白行剔除。
   * @param command 可能含换行的原始命令文本
   * @returns 拆分后的独立命令列表
   */
  splitCommand(command: string): string[]
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

/** 按续行规则拆分多行命令为独立命令（行尾匹配续行正则时与下一行合并，避免把续行命令拆断） */
function splitByContinuation(command: string, contRe: RegExp): string[] {
  const rawLines = command.split("\n")
  const cmds: string[] = []
  let buf = ""
  for (let line of rawLines) {
    const trailing = line.trimEnd()
    buf = buf ? buf + "\n" + line : line
    if (contRe.test(trailing)) continue // 行尾有续行符：继续合并下一行
    const cmd = buf.trim()
    if (cmd) cmds.push(cmd)
    buf = ""
  }
  const rest = buf.trim()
  if (rest) cmds.push(rest)
  return cmds
}

/**
 * POSIX（bash/zsh/sh）续行检测：未闭合的单/双引号或反引号（命令替换），或行尾未转义反斜杠。
 * 单引号内反斜杠为字面量；双引号/反引号内反斜杠转义下一个字符。
 * @param s 命令文本
 * @returns true 表示 shell 会等待续行
 */
function posixOpenContinuation(s: string): boolean {
  let inSingle = false
  let inDouble = false
  let inBacktick = false
  let escaped = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (escaped) { escaped = false; continue }
    if (c === "\\" && !inSingle) { escaped = true; continue }
    if (c === "'" && !inDouble && !inBacktick) { inSingle = !inSingle; continue }
    if (c === '"' && !inSingle) { inDouble = !inDouble; continue }
    if (c === "`" && !inSingle) { inBacktick = !inBacktick; continue }
  }
  // escaped 残留 = 行尾反斜杠（续行）
  return inSingle || inDouble || inBacktick || escaped
}

/**
 * PowerShell 续行检测：未闭合单/双引号，或行尾反引号（转义符 = 续行）。
 * 反引号转义下一个字符；单引号内不转义、双引号内 `""` 表示一个引号（本检测按配对开关处理即可）。
 * @param s 命令文本
 * @returns true 表示 shell 会等待续行
 */
function pwshOpenContinuation(s: string): boolean {
  let inSingle = false
  let inDouble = false
  let escaped = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (escaped) { escaped = false; continue }
    if (c === "`") { escaped = true; continue }
    if (c === "'" && !inDouble) { inSingle = !inSingle; continue }
    if (c === '"' && !inSingle) { inDouble = !inDouble; continue }
  }
  // escaped 残留 = 行尾反引号（续行）
  return inSingle || inDouble || escaped
}

/**
 * cmd.exe 续行检测：未闭合双引号，或行尾脱字符 `^`（转义/续行）。
 * @param s 命令文本
 * @returns true 表示 shell 会等待续行
 */
function cmdOpenContinuation(s: string): boolean {
  let inDouble = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === "^") { i++; continue } // ^ 转义下一个字符
    if (c === '"') { inDouble = !inDouble; continue }
  }
  return inDouble || /\^\s*$/.test(s)
}

class ZshAdapter implements ShellAdapter {
  readonly name = "zsh"
  readonly probeCommand = `echo ${SHELL_ID_PREFIX}$0`
  markerCmd(seq: number): string {
    // 结尾补换行：否则 zsh 判定"上条输出未以换行结束"，会补印 PROMPT_EOL_MARK（root 为 #）污染画面
    return `printf '\\n${DONE_TAG}${seq}:%s>\\n' $?`
  }
  splitCommand(command: string): string[] {
    // zsh 沿用 POSIX 反斜杠续行；注意 zsh 中反斜杠需转义处理（这里按普通反斜杠续行判断）
    return splitByContinuation(command, /\\\s*$/)
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
  markerCmd(seq: number): string {
    // bash 无 PROMPT_EOL_MARK，标记无需补尾换行（补了反而在 raw 里多顶一行）
    return `printf '\\n${DONE_TAG}${seq}:%s>' $?`
  }
  splitCommand(command: string): string[] {
    // bash/sh：反斜杠续行
    return splitByContinuation(command, /\\\s*$/)
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
  markerCmd(seq: number): string {
    // 用 Write-Output（success 管线）而非 Write-Host：Write-Host 直写 host 流会抢在
    // cmdlet 输出（经格式化器批量渲染）之前，导致 marker 落在命令输出之前、提取时把输出裁掉
    return `Write-Output "${DONE_TAG}${seq}:$LASTEXITCODE>"`
  }
  splitCommand(command: string): string[] {
    // PowerShell：行尾 `|`（管道续行）、反引号（显式换行转义）、未闭合 { / ( 时续行
    return splitByContinuation(command, /[|`]\s*$|[{(\s]*[{(]\s*$/)
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
  markerCmd(seq: number): string {
    return `echo ${DONE_TAG}${seq}:%errorlevel%>`
  }
  splitCommand(command: string): string[] {
    // cmd：行尾 `^`（转义换行符）表示续行
    return splitByContinuation(command, /\^\s*$/)
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