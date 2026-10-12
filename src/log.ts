// 共享日志模块：全局单例 logger + 降噪辅助（debug 门控 / 短窗去重 / 跨进程去重）
// 级别与开关口径（@xiaoqiong0v0/opencode-plugin-logger 1.0.6）：
// - 级别只是标签：底层以 `log(level, msg)` 原样落盘 `[level]`，**无内置门槛/过滤**——只要全局 enabled=true，
//   任何级别（含 "DEBUG"）都会写入；因此"debug 是否落盘"完全由本模块门控决定，而非底层级别。
// - 全局开关：`~/.config/opencode/plugin-logger.jsonc` 的 `enabled`（默认 false）。关闭时底层所有方法都是空函数，
//   本模块另以 LOG_ENABLED 同步判定，让各辅助函数**先判后做**（关闭时直接 return：不拼串 / 不建去重 Map / 不读写文件 / 不裁剪）。
// - debug 级：由环境变量 SSH_TOOL_DEBUG=1 门控（默认关）；开启且全局 enabled 时经 `log("DEBUG", …)` 原生级别落盘。
// 会话/终端标识约定（便于 `grep ses_xxx` 捞出一个会话的全部状态行）：
// - 处于会话/终端上下文的行必须带 `<主会话ID>/<终端名>`（如 ses_abc/default）；命令坐标用 `seq=<命令序号>`；
//   server 侧由 `sid:name` 键转成同一写法（server.ts keyTag），本地/SSH 传输层沿用既有的 `(session x, term y)` 写法。
// - 进程级事件（插件加载、agent 连上/断开服务、独立服务启停与替换、锁清理）本身没有单一会话归属，
//   只带 wsUrl / pid / port；若该事件牵涉具体终端（如断开受影响的终端、重连发现的运行中终端），
//   把受影响的 `<主会话ID>/<终端名>` 列表打进同一行。独立服务是另一进程，只能看到 key=`sid:name`，
//   拿不到 opencode 会话之外的上下文（其日志可按 sid 过滤，但无法按插件进程过滤）。
import createLogger from "@xiaoqiong0v0/opencode-plugin-logger"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { stripAnsi } from "./ansi.js"
import { CACHE_DIR } from "./constants.js"

const log = createLogger("opencode-ssh-tool")

/** 插件日志配置文件路径（与 opencode-plugin-logger 包内一致：~/.config/opencode/plugin-logger.jsonc） */
const LOGGER_CONFIG_PATH = join(homedir(), ".config", "opencode", "plugin-logger.jsonc")

/**
 * 判断插件日志是否全局启用：底层 logger 在 `enabled=false` 时会把 info/warn/… 全替换为空函数，
 * 但它**没有查询启用状态的 API**（返回对象只暴露方法），故这里按其同款口径自行解析配置：
 * 读取 `~/.config/opencode/plugin-logger.jsonc` 的 `enabled`（默认 false，与包内 defaults 一致）。
 * 配置路径与 JSONC 处理与包内 resolveCfg 保持一致（兼容注释）；任何读取/解析异常都降级为 false。
 * @returns 是否启用（true=会产生日志输出）
 */
function resolveLogEnabled(): boolean {
  try {
    const raw = readFileSync(LOGGER_CONFIG_PATH, "utf8")
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
    return (JSON.parse(raw) as { enabled?: unknown }).enabled === true
  } catch {
    return false
  }
}

/**
 * 全局日志开关（启动时解析一次）：logger 关闭时 info/warn/… 均为空函数，
 * 本模块各辅助函数据此**先判后做**——关闭时直接 return，不再维护去重窗口 Map、不再做字符串拼装/裁剪/文件读写。
 */
const LOG_ENABLED = resolveLogEnabled()

/**
 * debug 日志开关：默认关闭。底层 1.0.6 的 `log("DEBUG", …)` 只是级别标签、**无默认门槛**（全局 enabled=true 即落盘），
 * 故 debug 是否输出完全由本开关门控：周期性/心跳类细节（ssh2 协议 trace、探针 tick、轮询无变化等）
 * 默认不落盘，置 SSH_TOOL_DEBUG=1 后才记录。
 */
const DEBUG_ENABLED = /^(1|true|yes)$/i.test(process.env.SSH_TOOL_DEBUG ?? "")

/**
 * 当前是否会真正产出 debug 级日志（"日志全局启用" 且 "SSH_TOOL_DEBUG 打开"）。
 * 供调用方在**拼装日志字符串之前**短路（例如 ssh2 协议 trace 回调的注册），避免关闭时做无谓的字符串拼装。
 * @returns 是否启用 debug 级日志
 */
export function isDebugEnabled(): boolean {
  return LOG_ENABLED && DEBUG_ENABLED
}

/**
 * 记录 debug 级细节（周期性/心跳类噪声）：
 * 默认不输出，置环境变量 SSH_TOOL_DEBUG=1 后才写日志，避免刷屏又不丢取证能力。
 * 全局日志关闭时直接 return（不做任何拼装）。1.0.6 起用底层**原生级别** `log("DEBUG", …)` 落盘
 * （`[DEBUG]` 标签由底层按级别输出），不再有 "info + `[DEBUG]` 前缀" 的写法；
 * 调用方一律用 debug()/ssh2Trace()，不要自己写 log.info(...)（那样会绕过门控、无条件落盘）。
 * @param msg 日志内容（按本模块约定，带会话上下文的行须含 `<主会话ID>/<终端名>`）
 */
export function debug(msg: string): void {
  if (!isDebugEnabled()) return
  log.log("DEBUG", msg)
}

/** 随收发数据量增长的 ssh2 协议行（一次大输出/大文件传输会产生成千上万条）——一律不记 */
const SSH2_VOLUME_RE = /(CHANNEL_DATA|CHANNEL_EXTENDED_DATA|CHANNEL_WINDOW_ADJUST)/

/**
 * ssh2 协议 trace 落盘（debug 级）：只记**有界**的连接/握手/认证类事件，
 * `CHANNEL_DATA` / `CHANNEL_EXTENDED_DATA` / `CHANNEL_WINDOW_ADJUST` 这些**跟着输出/字节流增长**的协议行一律丢弃
 * （避免"每收到/发出一个数据包就记一行"式刷屏）。
 * @param tag 会话/终端标识（`<主会话ID>/<终端名>`）
 * @param msg ssh2 协议 trace 原文
 */
export function ssh2Trace(tag: string, msg: string): void {
  if (!isDebugEnabled()) return
  if (SSH2_VOLUME_RE.test(msg)) return
  log.log("DEBUG", `[ssh2] ${tag} ${msg}`)
}

/**
 * 取字符串最后 n 行（默认 3）：供"需要体现命令输出/缓冲内容"的日志做**有界摘要**，
 * 避免多行内容（如多行命令回显）把一条日志撑成多行、随内容增长。
 * 行数 ≤ n 时原样返回；全局日志关闭时直接返回原串（不做切分/裁剪）。
 * @param s 原始字符串
 * @param n 保留的最后行数（默认 3）
 * @returns 至多 n 行的字符串
 */
export function tailLines(s: string, n = 3): string {
  if (!LOG_ENABLED) return s
  const lines = s.split(/\r?\n/)
  return lines.length <= n ? s : lines.slice(-n).join("\n")
}

/**
 * 取命令输出供 `[run] 结束` 等日志附加的**有界尾部摘要**：
 * 输出是含 ANSI 的原始流（`_extractOutput` 产物，非渲染文本），先剥净 ANSI；再按终端渲染口径归一化每行
 * （行内 CR 覆盖只保留最后一次回车后的可见内容，避免进度条式行内刷新撑爆单行）、去行尾空白、剔除空行
 * （与模型可见文本 toModelText 口径一致：协议框定/回显产生的空行不算"输出行"）。
 * 仅当归一化后**行数 > n**（默认 3）时返回**末 n 行**，并把换行转义为 `\n` 字面量（保证整段摘要是单行、
 * 不随输出增长）；行数 ≤ n 时返回空串（短输出正文里已见，不重复附）。只取末尾有界行数，绝不打整段输出/字节流。
 * 全局日志关闭时直接返回空串（不做剥 ANSI / 切分 / 裁剪）。
 * @param s 命令输出（可能含 ANSI 的原始流）
 * @param n 保留的最后行数（默认 3）
 * @returns 空串，或转义换行后的末 n 行
 */
export function tailSummary(s: string, n = 3): string {
  if (!LOG_ENABLED) return ""
  const lines = stripAnsi(s)
    .split(/\r?\n/)
    .map(normalizeOutputLine)
    .filter((l) => l !== "")
  if (lines.length <= n) return ""
  return lines.slice(-n).join("\\n")
}

/**
 * 单行日志化归一：CR 覆盖只保留最后一次回车之后的可见内容（行尾孤立 CR 无覆盖内容时回退为去 CR），再去行尾空白。
 * @param line 原始单行（已剥 ANSI，可能含行内 CR）
 * @returns 归一化后的可见单行
 */
function normalizeOutputLine(line: string): string {
  const i = line.lastIndexOf("\r")
  const visible = i >= 0 ? line.slice(i + 1) : line
  return (visible !== "" ? visible : line.replace(/\r/g, "")).trimEnd()
}

/** 进程内去重窗口（毫秒）：同 key 重复消息在此窗口内只记一次 */
const DEDUP_WINDOW_MS = 3000
/** 各 key 的进程内去重状态：count=窗口内被抑制的次数，timer=窗口结束回补定时器 */
const dedupState = new Map<string, { count: number; timer: ReturnType<typeof setTimeout> }>()

/**
 * 进程内短窗去重记录：同 key 首次立即输出；窗口内重复只计数不输出；
 * 窗口结束时若有重复，补一条"<msg>（N 秒内重复 M 次）"，既不刷屏也不丢信息量。
 * @param key 去重键（相同 key 的同义消息合并）
 * @param msg 日志内容（首次与回补都用它）
 * @param windowMs 去重窗口（默认 3000ms）
 */
export function infoDedup(key: string, msg: string, windowMs = DEDUP_WINDOW_MS): void {
  if (!LOG_ENABLED) return
  const st = dedupState.get(key)
  if (st) {
    st.count += 1
    return
  }
  log.info(msg)
  const timer = setTimeout(() => {
    const cur = dedupState.get(key)
    if (!cur) return
    dedupState.delete(key)
    if (cur.count > 0) log.info(`${msg}（${Math.round(windowMs / 1000)}s 内重复 ${cur.count} 次）`)
  }, windowMs)
  if (typeof timer.unref === "function") timer.unref()
  dedupState.set(key, { count: 0, timer })
}

/** 跨进程去重标记目录（放在插件缓存根下，多进程共享，供批量实例加载场景合并重复行） */
const SHARED_DEDUP_DIR = join(homedir(), CACHE_DIR, ".log-dedup")

/** 把去重键规整为安全文件名（非字母数字替换为下划线） */
function dedupSafeName(key: string): string {
  return key.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 100)
}

/** 已排定"窗口结束回补汇总"定时器的跨进程 key（避免同进程重复排定） */
const sharedTimerKeys = new Set<string>()

/**
 * 跨进程短窗去重：多个 opencode 插件实例（各自独立进程）写同一日志文件时，
 * 用共享目录下的标记文件记录上次输出时刻与合并计数，窗口内的重复只记一次；
 * 创建窗口的进程在窗口结束时读计数补一条"N 秒内重复 M 次"，避免每个实例刷一整套。
 * 任何文件读写失败都静默降级为直接输出（不阻断日志，不影响插件行为）。
 * @param key 去重键（跨进程一致）
 * @param msg 日志内容
 * @param windowMs 去重窗口（默认 5000ms）
 */
export function infoDedupShared(key: string, msg: string, windowMs = 5000): void {
  if (!LOG_ENABLED) return
  try {
    const file = join(SHARED_DEDUP_DIR, dedupSafeName(key))
    const now = Date.now()
    let prev: { ts: number; count: number } | null = null
    try {
      prev = JSON.parse(readFileSync(file, "utf8")) as { ts: number; count: number }
    } catch {
      prev = null
    }
    if (prev && now - prev.ts < windowMs) {
      // 窗口内：仅累加计数，抑制输出
      prev.count += 1
      writeFileSync(file, JSON.stringify(prev), "utf8")
      return
    }
    mkdirSync(SHARED_DEDUP_DIR, { recursive: true })
    writeFileSync(file, JSON.stringify({ ts: now, count: 0 }), "utf8")
    // 上一窗口有合并的重复：先补一条汇总，再输出本次
    if (prev && prev.count > 0) {
      log.info(`${msg}（上次窗口内重复 ${prev.count} 次）`)
    }
    log.info(msg)
    // 窗口结束回补本窗口合并计数（本进程仍存活时；置 0 避免与下次懒汇总重复）
    if (!sharedTimerKeys.has(key)) {
      sharedTimerKeys.add(key)
      const timer = setTimeout(() => {
        sharedTimerKeys.delete(key)
        try {
          const cur = JSON.parse(readFileSync(file, "utf8")) as { ts: number; count: number }
          if (cur && cur.count > 0) {
            log.info(`${msg}（${Math.round(windowMs / 1000)}s 内重复 ${cur.count} 次）`)
            cur.count = 0
            writeFileSync(file, JSON.stringify(cur), "utf8")
          }
        } catch {
          /* 标记文件已不在，忽略 */
        }
      }, windowMs)
      if (typeof timer.unref === "function") timer.unref()
    }
  } catch {
    log.info(msg)
  }
}

export default log
