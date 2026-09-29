// 终端 ANSI 转义序列：统一模式源 + 剥离工具
// 供 utils.ts（命令回显的宽松匹配）与 shell-adapter.ts（语法错误识别前先剥净 ANSI）共用，避免重复定义。

/**
 * ANSI 转义序列的模式源（无捕获组，可安全嵌入其他正则）：
 * - CSI：`ESC [ 参数(数字/; /?) 终止字母`，同时覆盖 SGR（`\x1b[31m`）与光标/模式类序列
 *   （真实 ConPTY 常见 `\x1b[?25l`、`\x1b[39;1H`，旧模式只容忍 SGR 会漏掉它们）
 * - OSC：`ESC ] ... BEL` 或 `ESC ] ... ESC \`（窗口标题等）
 * - 其他两字节 ESC 序列（`ESC (`、`ESC =` 等）
 */
export const ANSI_SEQ_PATTERN = "\\x1b\\[[0-9;?]*[a-zA-Z]|\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)|\\x1b[^\\x1b]"

/** 全局 ANSI 匹配（仅用于 replace；String.replace 会重置 lastIndex，无状态残留） */
const ANSI_SEQ_RE = new RegExp(`(?:${ANSI_SEQ_PATTERN})`, "g")

/**
 * 剥离文本中的全部 ANSI 转义序列（CSI/OSC/其他 ESC 序列），保留换行与可见字符。
 * 语法错误识别前的预处理：真实 ConPTY 的错误行前常带 `\x1b[?25l`/`\x1b[39;1H` 等非 SGR 序列，
 * 直接匹配会漏判；剥净后可安全按"行首"判定（转义序列不含换行，行结构不变）。
 * @param s 含 ANSI 的原始文本
 * @returns 去掉全部转义序列的文本
 */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_SEQ_RE, "")
}
