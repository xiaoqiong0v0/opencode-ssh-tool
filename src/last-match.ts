// 通用末次匹配工具：终端备屏重放（如 cmatrix 退出时重绘主屏）会在字节流中产生重复内容，
// 因此所有"定位命令/标记"的搜索应取最后一次匹配而非首次。

/**
 * 返回字符串模式在文本中最后一次出现的结束位置
 * @param pattern 字面字符串
 * @param text 目标文本
 * @returns 匹配结束位置（不含），未找到返回 -1
 */
function lastStringEnd(pattern: string, text: string): number {
  const idx = text.lastIndexOf(pattern)
  return idx < 0 ? -1 : idx + pattern.length
}

/**
 * 返回正则模式在文本中最后一次匹配的结束位置
 * @param pattern 正则
 * @param text 目标文本
 * @param fromPos 搜索起点
 * @returns 匹配结束位置（不含），未找到返回 -1
 */
function lastRegExpEnd(pattern: RegExp, text: string, fromPos: number): number {
  const g = pattern.global ? pattern : new RegExp(pattern.source, pattern.flags + "g")
  g.lastIndex = fromPos
  let last = -1
  let m: RegExpExecArray | null
  while ((m = g.exec(text)) !== null) {
    last = m.index + m[0].length
    if (m[0].length === 0) g.lastIndex++
  }
  return last
}

/**
 * 通用末次匹配：返回模式最后一次出现/匹配的结束位置
 * @param pattern 字面字符串或正则
 * @param text 目标文本
 * @param fromPos 正则模式搜索起点（字符串模式忽略）
 * @returns 结束位置（不含），未找到返回 -1
 */
export function findLastEndOf(pattern: string | RegExp, text: string, fromPos = 0): number {
  if (typeof pattern === "string") return lastStringEnd(pattern, text)
  return lastRegExpEnd(pattern, text, fromPos)
}

/**
 * 返回正则模式在文本中最后一次匹配的结果（含捕获组）
 * @param pattern 正则
 * @param text 目标文本
 * @param fromPos 搜索起点
 * @returns 最后一次匹配结果；未找到返回 null
 */
export function findLastMatch(pattern: RegExp, text: string, fromPos = 0): RegExpExecArray | null {
  const g = pattern.global ? pattern : new RegExp(pattern.source, pattern.flags + "g")
  g.lastIndex = fromPos
  let last: RegExpExecArray | null = null
  let m: RegExpExecArray | null
  while ((m = g.exec(text)) !== null) {
    last = m
    if (m[0].length === 0) g.lastIndex++
  }
  return last
}
