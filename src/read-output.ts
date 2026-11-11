// read 输出布局与选择（纯函数，供 doRead 复用并便于单测）
// 约定：首行是工具元数据，空行后才是实际命令输出；不拼接浏览器 URL。

import { tr, type Lang } from "./i18n.js"

/** read 的数据来源：buffer（实时缓冲）/ history（已完成命令历史） */
export type ReadSource = "buffer" | "history"

/**
 * 生成 read 首行元数据。
 * @param lang 工具语言
 * @param name 终端名
 * @param source 数据来源
 * @param state 终端状态
 * @param note 可选提示（partial / completed-only）
 * @returns 首行元数据
 */
export function formatReadHeader(lang: Lang, name: string, source: ReadSource, state: "busy" | "idle", note?: "partial" | "completed-only"): string {
  const header = tr("read_header", lang).replace("{name}", name).replace("{source}", source).replace("{state}", state)
  return note ? `${header} note=${note}` : header
}

/**
 * 统一 read 输出布局：首行工具元数据，空行后是实际输出。
 * @param header 元数据行（含 [term_cli read]）
 * @param output 实际命令输出
 * @param emptyText 无输出时的提示
 * @returns header + 空行 + output（或 emptyText）
 */
export function formatReadResult(header: string, output: string, emptyText: string): string {
  const actual = output.trim() ? output : emptyText
  return `${header}\n\n${actual}`
}

/**
 * 取最后一个元素；空数组返回 undefined。
 * @param items 数组
 * @returns 最后元素或 undefined
 */
export function lastItem<T>(items: T[]): T | undefined {
  return items.length ? items[items.length - 1] : undefined
}
