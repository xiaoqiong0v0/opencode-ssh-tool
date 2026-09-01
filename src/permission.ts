// 权限判定：先黑后白再问，白名单整串匹配 + 元字符降级 ask

import { ALLOW_READONLY, DENY, SHELL_META } from "./constants.js"

/** 权限判定结果 */
export type Decision = "allow" | "deny" | "ask"

/**
 * 判定命令走哪种审批路径
 * @param command 完整命令
 * @returns allow=白名单直接放行；deny=高危直接拒绝；ask=需用户审批
 */
export function decide(command: string): Decision {
  const trimmed = command.trim()

  // 先黑：高危命令直接拒绝
  if (DENY.test(trimmed)) return "deny"

  // 白名单必须整串匹配且不含 shell 元字符（防拼接绕过）
  if (SHELL_META.test(trimmed)) return "ask"
  if (ALLOW_READONLY.test(trimmed)) return "allow"

  return "ask"
}
