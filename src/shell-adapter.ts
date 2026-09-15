// Shell 适配器：Shell 类型探测 + 可见完成标记注入/检测
// 标记格式：<SSH_DONE:<退出码>>  —— 可见文本便于 web Raw 模式直接调试；
// 展示给用户/模型的输出会在上层剥离标记（用户实际看不到，与不可见标记等效）

import { DONE_TAG, INJECT_TOKEN, SHELL_ID_PREFIX, VAR_NESTED, VAR_ORIG_RL, VAR_PENDING, VAR_HID } from "./constants.js"
import { findLastMatch } from "./last-match.js"

/** Shell 适配器接口 */
export interface ShellAdapter {
  readonly name: string
  readonly probeCommand: string
  parseProbe(output: string): boolean
  buildInjectScript(): string
}

// ===== 完成标记检测（在原始字节流中定位/剥离 <SSH_DONE:退出码>） =====

const DONE_RE = /<SSH_DONE:(-?\d+)>/g

export function detectLastDoneMarker(buffer: string, fromPos: number): { done: boolean; exitCode: number; pos: number } {
  // 取最后一个合法标记（退出码为数字）——避免注入脚本字面文本 <SSH_DONE:%s> 被误判
  const m = findLastMatch(DONE_RE, buffer, fromPos)
  if (!m) return { done: false, exitCode: 0, pos: 0 }
  return { done: true, exitCode: parseInt(m[1], 10) || 0, pos: m.index + m[0].length }
}

export function stripMarkers(raw: string): string {
  return raw.replace(DONE_RE, "")
}

// ===== Shell 类型探测与注入脚本 =====
class ZshAdapter implements ShellAdapter {
  readonly name = "zsh"
  readonly probeCommand = `echo ${SHELL_ID_PREFIX}$0`
  parseProbe(output: string): boolean {
    return new RegExp(`${SHELL_ID_PREFIX}zsh|(?:^|\\W)zsh(?:\\W|$)`, "i").test(output)
  }
  buildInjectScript(): string {
    return `PS1='${DONE_TAG}%?>'"\$PS1"; echo ${INJECT_TOKEN}`
  }
}

// ===== Bash 系（bash / sh） =====
class BashAdapter implements ShellAdapter {
  readonly name = "bash"
  readonly probeCommand = `echo ${SHELL_ID_PREFIX}$0`
  parseProbe(output: string): boolean {
    return new RegExp(`${SHELL_ID_PREFIX}(bash|sh)\\b|(?:^|\\W)(bash|sh)(?:\\W|$)`, "i").test(output)
  }
  buildInjectScript(): string {
    // 追加链式不覆盖 PROMPT_COMMAND（避免 p10k 等框架重置后失效）；
    // 不用 HISTCMD 守卫（kali 下不可靠），重复标记由检测端取最后一个兼容
    return `__ssh_prompt() { local ec=$?; printf '\\n${DONE_TAG}%s>' "$ec"; }; __ssh_pc="\${PROMPT_COMMAND:-}"; PROMPT_COMMAND="__ssh_prompt\${__ssh_pc:+; }\$__ssh_pc"; echo ${INJECT_TOKEN}`
  }
}

// ===== PowerShell =====
class PwshAdapter implements ShellAdapter {
  readonly name = "pwsh"
  readonly probeCommand = `echo ${SHELL_ID_PREFIX}$0`
  parseProbe(_output: string): boolean {
    return true
  }
  buildInjectScript(): string {
    return `function global:prompt { $h = Get-History -Count 1; $hid = if ($h) { $h.Id } else { 0 }; $nested = $nestedPromptLevel; $ec = $LASTEXITCODE; if ($null -eq $ec) { $ec = 0 }; $s = ""; if ($null -eq $global:${VAR_PENDING} -or $global:${VAR_PENDING} -or $hid -ne $global:${VAR_HID} -or $nested -lt $global:${VAR_NESTED}) { $s = "${DONE_TAG}$ec>" }; $global:${VAR_PENDING} = $false; $global:${VAR_HID} = $hid; $global:${VAR_NESTED} = $nested; $s + "PS $($executionContext.SessionState.Path.CurrentLocation)$('>' * ($nestedPromptLevel + 1)) " }; if ($function:PSConsoleHostReadLine) { $global:${VAR_ORIG_RL} = $function:PSConsoleHostReadLine; function global:PSConsoleHostReadLine { $global:${VAR_PENDING} = $true; & $global:${VAR_ORIG_RL} } }; echo ${INJECT_TOKEN}`
  }
}

/** 注册表（按优先级排列） */
const adapters: ShellAdapter[] = [
  new ZshAdapter(),
  new BashAdapter(),
  new PwshAdapter(),
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
