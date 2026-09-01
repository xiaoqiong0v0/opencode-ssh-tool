// 配置文件读取：~/.config/opencode/ssh-tool.jsonc（服务/记录/语言），首次运行自动生成模板

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Lang } from "./i18n.js"

/** HTTP 服务配置 */
export interface ServerConfig {
  enabled: boolean
  port: number
}

/** 会话记录（命令+输出 消息对）配置 */
export interface HistoryConfig {
  maxMessages: number
  spillThreshold: number
}

/** 权限自定义正则配置（追加到内置默认，控制"拒绝"与"需审批"命令） */
export interface PermissionConfig {
  /** 危险命令正则（命中直接拒绝），如 ["^mkfs\\s", "^dd\\s"] */
  deny: string[]
  /** 只读白名单正则（命中且无 shell 元字符则直接放行），如 ["^df\\s.*-h$"] */
  allow: string[]
}

/** 工具整体配置 */
export interface ToolConfig {
  server: ServerConfig
  history: HistoryConfig
  /** 工具描述语言（默认 en，可用环境变量 SSH_TOOL_LANG 覆盖） */
  toolLang: Lang
  permission: PermissionConfig
}

/** 配置默认值 */
const DEFAULT_CONFIG: ToolConfig = {
  server: {
    enabled: true,
    // 端口不设默认值：0 = 自动分配随机端口（避免冲突）
    port: 0,
  },
  history: {
    // 保留的消息对数（最小 1，保留最新）
    maxMessages: 100,
    // 单条命令+输出超此字节数写文件（默认 3MB）
    spillThreshold: 3 * 1024 * 1024,
  },
  toolLang: "en",
  permission: {
    deny: [],
    allow: [],
  },
}

/** 配置文件路径：~/.config/opencode/ssh-tool.jsonc */
function configPath(): string {
  const dir = process.env.USERPROFILE || process.env.HOME || homedir()
  return join(dir, ".config", "opencode", "ssh-tool.jsonc")
}

/** 配置模板（首次运行生成） */
const CONFIG_TEMPLATE = `{
  // HTTP 终端记录服务开关（默认 true）
  "server": {
    "enabled": true,
    // 端口：不设默认值。0 = 自动分配随机端口（推荐，避免冲突）；可显式指定，如 8137
    "port": 0
  },
  // 会话记录（命令+输出 消息对）管理
  "history": {
    // 保留的消息对数上限（默认 100，最小 1）。超出时移除最旧的一对
    "maxMessages": 100,
    // 单条命令+输出超过此字节数时写入文件（默认 3145728 = 3MB），内存只存引用
    "spillThreshold": 3145728
  },
  // 工具描述语言："en" | "zh"（默认 "en"，可用环境变量 SSH_TOOL_LANG 覆盖）
  "toolLang": "en",
  // 权限自定义正则（追加到内置默认，控制"拒绝"与"需审批"命令）
  "permission": {
    // 内置默认危险命令黑名单（命中直接拒绝，不需要重复添加）：
    //   rm\s+-rf | shutdown | reboot | mkfs | dd\s | DROP\s+TABLE | TRUNCATE\s+TABLE | >\s*\/etc\/passwd
    // 自定义补充示例：["^mkfs\\s", "^dd\\s"]（此数组为空 = 仅使用内置默认）
    "deny": [],
    // 内置默认只读白名单（命中且无 shell 元字符则直接放行）：
    //   ls | cd | cat | grep | tail | head | ps | df | free | pwd | env | echo | curl | wget | git status | whoami | hostname | date | uname | uptime
    // 自定义补充示例：["^df\\s.*-h$"]（此数组为空 = 仅使用内置默认）
    "allow": []
  }
}
`

/**
 * 去除 jsonc 注释后解析为对象（支持 // 与 /* *\/）
 * @param text jsonc 文本
 * @returns 解析结果对象
 */
function parseJsonc(text: string): Record<string, unknown> {
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
  return JSON.parse(stripped)
}

/**
 * 加载工具配置：读 jsonc，缺失项用默认值；文件不存在则自动生成模板
 * @returns 工具配置
 */
export function loadConfig(): ToolConfig {
  try {
    const path = configPath()
    if (!existsSync(path)) {
      mkdirSync(join(path, ".."), { recursive: true })
      writeFileSync(path, CONFIG_TEMPLATE, "utf8")
      return DEFAULT_CONFIG
    }
    const raw = parseJsonc(readFileSync(path, "utf8"))
    const server = (raw.server ?? {}) as Partial<ServerConfig>
    const history = (raw.history ?? {}) as Partial<HistoryConfig>
    const permission = (raw.permission ?? {}) as Partial<PermissionConfig>
    const toolLang = raw.toolLang === "zh" ? "zh" : "en"
    return {
      server: {
        enabled: server.enabled ?? DEFAULT_CONFIG.server.enabled,
        port: server.port ?? DEFAULT_CONFIG.server.port,
      },
      history: {
        maxMessages: Math.max(1, history.maxMessages ?? DEFAULT_CONFIG.history.maxMessages),
        spillThreshold: history.spillThreshold ?? DEFAULT_CONFIG.history.spillThreshold,
      },
      toolLang,
      permission: {
        deny: Array.isArray(permission.deny) ? permission.deny : [],
        allow: Array.isArray(permission.allow) ? permission.allow : [],
      },
    }
  } catch (e) {
    // 配置解析失败回退默认
    return DEFAULT_CONFIG
  }
}
