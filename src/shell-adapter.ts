// Shell 适配器：Shell 类型探测 + 可见完成标记注入/检测
// 标记格式：<SSH_DONE:<退出码>>  —— 可见文本便于 web Raw 模式直接调试；
// 展示给用户/模型的输出会在上层剥离标记（用户实际看不到，与不可见标记等效）

/** Shell 适配器接口 */
export interface ShellAdapter {
  readonly name: string
  /** Shell 探测命令 */
  readonly probeCommand: string
  /** 解析探测输出，返回 true 表示匹配 */
  parseProbe(output: string): boolean
  /** 注入脚本（连接后执行一次，让 shell 在每条命令完成后输出可见完成标记） */
  readonly injectScript: string
}

/** 可见完成标记正则（退出码兼容 pwsh 负数，如 -1） */
const DONE_RE = /<SSH_DONE:(-?\d+)>/g

/**
 * 在缓冲中定位下一个 done 标记
 * @param buffer 原始终端流
 * @param fromPos 搜索起点
 * @returns done 是否找到；exitCode 退出码；pos 标记结束位置
 */
export function detectDoneMarker(buffer: string, fromPos: number): { done: boolean; exitCode: number; pos: number } {
  DONE_RE.lastIndex = fromPos
  const m = DONE_RE.exec(buffer)
  if (!m) return { done: false, exitCode: 0, pos: 0 }
  return { done: true, exitCode: parseInt(m[1], 10) || 0, pos: m.index + m[0].length }
}

/**
 * 从原始流中剥离完成标记（给用户/模型的输出前调用）
 * @param raw 原始终端流
 * @returns 剥离标记后的流
 */
export function stripMarkers(raw: string): string {
  return raw.replace(DONE_RE, "")
}

// ===== Bash 系（bash / sh / zsh） =====
// PROMPT_COMMAND 在每条命令执行完、绘制下一条提示符前执行 —— 是 bash 的可靠"命令完成"钩子
class BashAdapter implements ShellAdapter {
  readonly name = "bash"
  readonly probeCommand = "echo __SHELL_ID__$0"

  parseProbe(output: string): boolean {
    return /\b(bash|sh|zsh)\b/i.test(output)
  }

  readonly injectScript = `__ssh_prompt() { local ec=$?; printf '\\n<SSH_DONE:%s>' "$ec"; }
PROMPT_COMMAND=__ssh_prompt`
}

// ===== PowerShell =====
// pwsh 无 PROMPT_COMMAND；改 prompt() 函数（VSCode 同款机制）：
// 每条命令完成后 pwsh 会重新调用 prompt() 获取下一条提示符，此时在返回串开头输出完成标记
class PwshAdapter implements ShellAdapter {
  readonly name = "pwsh"
  readonly probeCommand = "echo __SHELL_ID__$0"

  parseProbe(_output: string): boolean {
    // pwsh 没有 $0，echo 输出可能为空或报错
    // 如果 bash 探测失败，再尝试 pwsh 探测
    return false
  }

  // pwsh 无 PROMPT_COMMAND：改写 prompt() 函数（VSCode 同款机制）。
  // 命令结束（含 Ctrl-C 中断）后 pwsh 重绘提示符 → 在返回串开头输出完成标记。
  // 用 PSConsoleHostReadLine 钩子在"读取命令前"置 __SSH_PENDING，prompt() 据此发标记：
  //   - 命令正常/中断完成 → prompt() 发标记
  //   - resize/空闲重绘（未读命令）→ 不发
  // 兜底：history 前进 或 嵌套等级下降（多行模式 Ctrl-C 退出）也发，防钩子不可用
  readonly injectScript = [
    `function global:prompt { $h = Get-History -Count 1; $hid = if ($h) { $h.Id } else { 0 }; $nested = $nestedPromptLevel; $ec = $LASTEXITCODE; if ($null -eq $ec) { $ec = 0 }; $s = ""; if ($null -eq $global:__SSH_PENDING -or $global:__SSH_PENDING -or $hid -ne $global:__SSH_HID -or $nested -lt $global:__SSH_NESTED) { $s = "<SSH_DONE:$ec>" }; $global:__SSH_PENDING = $false; $global:__SSH_HID = $hid; $global:__SSH_NESTED = $nested; $s + "PS $($executionContext.SessionState.Path.CurrentLocation)$('>' * ($nestedPromptLevel + 1)) " }`,
    `if ($function:PSConsoleHostReadLine) { $global:__SSH_ORIG_RL = $function:PSConsoleHostReadLine; function global:PSConsoleHostReadLine { $global:__SSH_PENDING = $true; & $global:__SSH_ORIG_RL } }`,
  ].join("\n")
}

/** 注册表（按优先级排列） */
const adapters: ShellAdapter[] = [
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
  // 默认 bash（pwsh 的 probe 也会返回 false，所以走到这里就是 pwsh）
  return adapters[1]
}
