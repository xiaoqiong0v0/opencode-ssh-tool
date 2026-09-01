// 认证信息读取：key / agent / 环境变量密码，优先级依次降低，不硬编码

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** 认证信息（互斥，按优先级取其一） */
export interface AuthInfo {
  key?: string
  agent?: string
  password?: string
}

/** 用户默认 SSH 私钥文件名（按优先级） */
const DEFAULT_KEYS = ["id_ed25519", "id_rsa"]

/** SSH agent socket 环境变量 */
const AGENT_ENV = "SSH_AUTH_SOCK"

/** 通用密码环境变量 */
const PASSWORD_ENV = "SSH_PASSWORD"

/**
 * 解析指定主机的认证信息，优先级：key > agent > 环境变量密码
 * @param host 目标主机
 * @returns 认证信息（任一字段可选）
 */
export function resolveAuth(host: string): AuthInfo {
  // 1. 用户默认 SSH 私钥（存在才用）
  const sshDir = join(homedir(), ".ssh")
  for (const name of DEFAULT_KEYS) {
    const p = join(sshDir, name)
    if (existsSync(p)) {
      return { key: readFileSync(p, "utf8") }
    }
  }

  // 2. SSH agent socket（Unix）—— Windows 走 OpenSSH agent 时由 ssh2 自动处理
  const agent = process.env[AGENT_ENV]
  if (agent) {
    return { agent }
  }

  // 3. 环境变量密码：SSH_PASS_<HOST大写> 优先，回退 SSH_PASSWORD
  const hostKey = `SSH_PASS_${host.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`
  const password = process.env[hostKey] ?? process.env[PASSWORD_ENV]
  if (password) {
    return { password }
  }

  return {}
}
