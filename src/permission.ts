// 权限判定：先黑后白再问，白名单整串匹配 + 元字符降级 ask
// 支持配置自定义 deny/allow 正则（追加到内置默认）

import { ALLOW_READONLY, DENY, SHELL_META } from "./constants.js"

/** 权限判定结果 */
export type Decision = "allow" | "deny" | "ask"

/** 命令判定器 */
export type CommandDecider = (command: string) => Decision

/**
 * 创建命令判定器：内置正则 + 用户自定义正则（配置 permission.deny / permission.allow）
 * @param customDeny 自定义危险命令正则数组（追加到内置 DENY）
 * @param customAllow 自定义只读白名单正则数组（追加到内置 ALLOW_READONLY）
 * @returns 判定函数
 */
export function createDecider(customDeny: string[] = [], customAllow: string[] = []): CommandDecider {
  const denyRegexes = [DENY, ...customDeny.map((s) => new RegExp(s))]
  const allowRegexes = [ALLOW_READONLY, ...customAllow.map((s) => new RegExp(s))]

  return function decide(command: string): Decision {
    const trimmed = command.trim()

    // 先黑：高危命令直接拒绝
    if (denyRegexes.some((re) => re.test(trimmed))) return "deny"

    // 白名单必须整串匹配且不含 shell 元字符（防拼接绕过）
    if (SHELL_META.test(trimmed)) return "ask"
    if (allowRegexes.some((re) => re.test(trimmed))) return "allow"

    return "ask"
  }
}
