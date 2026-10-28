// read 返回值的 busy 提示（纯函数，供 doRead 复用并便于单测）
// 只有命令运行中（busy=true）才提示"这不是最终结果"；空闲时保持旧输出格式不变。

import { tr, type FlatKey, type Lang } from "./i18n.js"

/** read 的数据来源：buffer（实时缓冲）/ history（已完成命令历史） */
export type ReadSource = "buffer" | "history"

/** 各来源在 busy=true 时的提示文案键 */
const BUSY_NOTICE_KEYS: Record<ReadSource, FlatKey> = {
  buffer: "read_busy_buffer_notice",
  history: "read_busy_history_notice",
}

/**
 * 生成 read 返回值的 busy 前缀与警告（i18n）。
 * @param source 本次读取来源
 * @param busy 读取时终端是否仍有运行中的命令
 * @param lang 工具语言
 * @returns busy=false 时为空串；busy=true 时为"前缀 + 警告 + 换行"
 */
export function readBusyNotice(source: ReadSource, busy: boolean, lang: Lang): string {
  if (!busy) return ""
  return `${tr(BUSY_NOTICE_KEYS[source], lang)}\n`
}
