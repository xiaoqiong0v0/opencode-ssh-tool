// 认证信息读取：key / agent / 环境变量密码，优先级依次降低，不硬编码

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import createLogger from "@xiaoqiong0v0/opencode-plugin-logger"

const log = createLogger("opencode-ssh-tool", { enabled: true })

/** 认证信息（互斥，按优先级取其一），字段名对齐 ssh2 ConnectConfig */
export interface AuthInfo {
  privateKey?: string
  agent?: string
  password?: string
}

/** 用户默认 SSH 私钥文件名（按优先级） */
const DEFAULT_KEYS = ["id_ed25519", "id_rsa"]

/** SSH agent socket 环境变量 */
const AGENT_ENV = "SSH_AUTH_SOCK"

/** 通用密码环境变量 */
const PASSWORD_ENV = "SSH_PASSWORD"

/** 密码文件路径前缀：password 参数以该前缀开头时按文件读取（避免明文暴露在上下文） */
const PASSWORD_FILE_PREFIX = "file:"

/**
 * 计算用户 .ssh 目录：Windows 优先 USERPROFILE，其次 HOME，最后 os.homedir()
 * @returns .ssh 目录绝对路径
 */
function sshDir(): string {
  const home = process.env.USERPROFILE || process.env.HOME || homedir()
  return join(home, ".ssh")
}

/**
 * 解析指定主机的认证信息，优先级：key > agent > 环境变量密码
 * @param host 目标主机
 * @returns 认证信息（任一字段可选）
 */
export function resolveAuth(host: string): AuthInfo {
  // 1. 用户默认 SSH 私钥（存在才用）
  const dir = sshDir()
  for (const name of DEFAULT_KEYS) {
    const p = join(dir, name)
    if (existsSync(p)) {
      log.info(`使用私钥认证 ${p}`)
      return { privateKey: readFileSync(p, "utf8") }
    }
  }
  log.info(`未找到私钥（dir=${dir}，${DEFAULT_KEYS.join("/")}）`)

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

/**
 * 解析密码参数：明文 或 file:路径（从文件读取，去除末尾换行）
 * @param password 明文密码 或 "file:<绝对路径>"；为空返回 undefined
 * @returns 实际密码；文件读取失败返回 undefined（调用方回退 resolveAuth）
 */
export function resolvePassword(password?: string): string | undefined {
  if (!password) return undefined
  if (!password.startsWith(PASSWORD_FILE_PREFIX)) return password
  const p = password.slice(PASSWORD_FILE_PREFIX.length)
  try {
    return readFileSync(p, "utf8").replace(/\r?\n$/, "")
  } catch (e) {
    log.error(`读取密码文件失败 ${p}`, e instanceof Error ? e.message : String(e))
    return undefined
  }
}
