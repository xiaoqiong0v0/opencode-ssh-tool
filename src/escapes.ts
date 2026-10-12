// 终端转义文本解码：把 send()/term_send 载荷里的转义写法解成真实控制字节
// 口径（单一实现，前端真实字节与模型转义文本两条路径共用同一份规则）：
// - \xHH → 对应字节（x/X 大小写、十六进制 0-9a-fA-F 大小写均支持）
// - \t → TAB(0x09)；\r → CR；\n → CR（保留既有语义：\n 也当回车提交，刻意为之）
// - \\ → 一个字面反斜杠（转义反斜杠），随后字符不再按转义解析（防重复解码）
// - 非法/不完整写法（\xZ、结尾单个 \）原样保留，绝不破坏其余文本

/** \xHH 的两位十六进制校验（大小写均接受） */
const HEX2_RE = /^[0-9a-fA-F]{2}$/

/**
 * 解码载荷中的转义文本为真实控制字节（单遍扫描，从左到右）。
 * 已经是真实字节的载荷（如前端直接发送的 0x7f/0x09/ESC 序列）不受影响：它们不含反斜杠转义，
 * 逐字符原样通过；只有反斜杠起始的已知/合法转义才被替换。
 * @param text 载荷（可能含 \xHH / \r / \n / \t / \\ 等转义写法，也可能已是真实字节）
 * @returns 解码后的载荷（真实字节）
 */
export function decodeTerminalEscapes(text: string): string {
  let out = ""
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c !== "\\") {
      out += c
      continue
    }
    const next = text[i + 1]
    if (next === undefined) {
      // 结尾单个反斜杠：不完整写法，原样保留
      out += "\\"
      continue
    }
    if (next === "\\") {
      // 转义反斜杠：产出一个字面反斜杠，跳过两个字符（后续不重复解码）
      out += "\\"
      i++
      continue
    }
    if (next === "r") {
      out += "\r"
      i++
      continue
    }
    if (next === "n") {
      // 保留既有语义：\n 解为回车（CR），与提交行分隔符一致，刻意为之
      out += "\r"
      i++
      continue
    }
    if (next === "t") {
      out += "\t"
      i++
      continue
    }
    if (next === "x" || next === "X") {
      const hex = text.slice(i + 2, i + 4)
      if (HEX2_RE.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16))
        i += 3
        continue
      }
    }
    // 非法/不完整转义（如 \xZ）：保留反斜杠本身，其后字符照常处理，不破坏原文本
    out += "\\"
  }
  return out
}
