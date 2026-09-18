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

class ZshAdapter implements ShellAdapter {
  readonly name = "zsh"
  readonly probeCommand = `echo ${SHELL_ID_PREFIX}$0`
  markerCmd(seq: number): string {
    return `printf '\\n${DONE_TAG}${seq}:%s>' $?`
  }
  splitCommand(command: string): string[] {
    // zsh 沿用 POSIX 反斜杠续行；注意 zsh 中反斜杠需转义处理（这里按普通反斜杠续行判断）
    return splitByContinuation(command, /\\\s*$/)
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
    return `printf '\\n${DONE_TAG}${seq}:%s>' $?`
  }
  splitCommand(command: string): string[] {
    // bash/sh：反斜杠续行
    return splitByContinuation(command, /\\\s*$/)
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
    return `Write-Host "${DONE_TAG}${seq}:$LASTEXITCODE>"`
  }
  splitCommand(command: string): string[] {
    // PowerShell：行尾 `|`（管道续行）、反引号（显式换行转义）、未闭合 { / ( 时续行
    return splitByContinuation(command, /[|`]\s*$|[{(\s]*[{(]\s*$/)
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