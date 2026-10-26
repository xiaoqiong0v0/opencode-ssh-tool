// 文件传输任务事件（agent → server → Web）：只承载元数据，绝不包含文件内容。
//
// 协议：
// - agent → server：{ type: "transfer", task }
// - server → web：  { type: "transfer", task } 广播；{ type: "transfers", tasks } 快照
//
// 本模块只做类型定义与不可信输入的严格校验；server 在写内存/广播前必须先经 parseTransferTask，
// 避免 agent 侧的异常值（未知方向/状态、超长路径、负数字节等）污染服务端状态或 Web 页面。

import {
  TRANSFER_TASK_ERROR_CODE_MAX,
  TRANSFER_TASK_ID_MAX,
  TRANSFER_TASK_NAME_MAX,
  TRANSFER_TASK_PATH_MAX,
  TRANSFER_TASK_SESSION_ID_MAX,
} from "./constants.js"

/** 传输方向 */
export type TransferDirection = "upload" | "download"

/** 传输任务状态（running=传输中；done=成功；failed=失败） */
export type TransferState = "running" | "done" | "failed"

/** 传输任务元数据（不含文件内容） */
export interface TransferTask {
  /** 任务 ID（agent 生成，随机 UUID） */
  id: string
  /** 所属主会话 ID */
  sessionID: string
  /** 终端名 */
  name: string
  /** 传输方向 */
  direction: TransferDirection
  /** 本机路径（成功时由结果回填展开后的实际路径） */
  localPath: string
  /** 远端路径 */
  remotePath: string
  /** 当前状态 */
  state: TransferState
  /** 已传字节数 */
  bytes: number
  /** 总字节数（来自 stat；未知时为 0） */
  total: number
  /** 开始时间（毫秒时间戳） */
  startedAt: number
  /** 结束时间（毫秒时间戳；running 时缺省） */
  endedAt?: number
  /** 失败机器码（如 exists/timeout/denied；成功时缺省） */
  errorCode?: string
}

const DIRECTIONS: readonly string[] = ["upload", "download"]
const STATES: readonly string[] = ["running", "done", "failed"]

/**
 * 判断是否为长度受限的非空字符串。
 * @param value 待校验值
 * @param max 最大长度
 * @returns true 表示合法
 */
function isBoundedNonEmptyString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max
}

/** 判断是否为非负有限整数（字节数/时间戳） */
function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

/**
 * 解析并校验不可信的传输任务（agent 上报 / 测试输入）。
 * - 字段类型与长度严格校验，未知 direction/state 一律拒绝；
 * - 只保留协议白名单字段，丢弃未知字段（防止文件内容/额外敏感数据被透传）；
 * - 不校验 bytes ≤ total（进度回调与最终结果允许在文件增长等边界下不严格相等）。
 * @param value 不可信输入
 * @returns 校验通过的任务副本；不合法时 null
 */
export function parseTransferTask(value: unknown): TransferTask | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const v = value as Record<string, unknown>

  if (!isBoundedNonEmptyString(v.id, TRANSFER_TASK_ID_MAX)) return null
  if (!isBoundedNonEmptyString(v.sessionID, TRANSFER_TASK_SESSION_ID_MAX)) return null
  if (!isBoundedNonEmptyString(v.name, TRANSFER_TASK_NAME_MAX)) return null
  if (typeof v.direction !== "string" || !DIRECTIONS.includes(v.direction)) return null
  if (!isBoundedNonEmptyString(v.localPath, TRANSFER_TASK_PATH_MAX)) return null
  if (!isBoundedNonEmptyString(v.remotePath, TRANSFER_TASK_PATH_MAX)) return null
  if (typeof v.state !== "string" || !STATES.includes(v.state)) return null
  if (!isNonNegativeInt(v.bytes)) return null
  if (!isNonNegativeInt(v.total)) return null
  if (!isNonNegativeInt(v.startedAt)) return null
  if (v.endedAt !== undefined && !isNonNegativeInt(v.endedAt)) return null
  if (v.errorCode !== undefined && !isBoundedNonEmptyString(v.errorCode, TRANSFER_TASK_ERROR_CODE_MAX)) return null

  const task: TransferTask = {
    id: v.id,
    sessionID: v.sessionID,
    name: v.name,
    direction: v.direction as TransferDirection,
    localPath: v.localPath,
    remotePath: v.remotePath,
    state: v.state as TransferState,
    bytes: v.bytes,
    total: v.total,
    startedAt: v.startedAt,
  }
  if (v.endedAt !== undefined) task.endedAt = v.endedAt as number
  if (v.errorCode !== undefined) task.errorCode = v.errorCode as string
  return task
}
