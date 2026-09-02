// 工具函数：哨兵生成、回显剔除、ANSI 清洗、CR 覆盖合并、提示符剥离

import { randomBytes } from "node:crypto"

/**
 * 生成命令完成哨兵标记（随机后缀防撞词）
 * @returns 哨兵字符串
 */
export function genSentinel(): string {
  return `__SSH_DONE_${randomBytes(6).toString("hex")}__`
}

/**
 * 剔除 PTY 回显的命令行（含提示符前缀，如 "user@host:~$ cmd"），并清理残留 CR
 * 同时剔除含哨兵标记的行（上次命令在哨兵之后到达的回显残留，避免污染下一条输出）
 * @param raw 原始输出
 * @param cmd 已发送命令（组合串）
 * @returns 剔除回显后的输出
 */
export function stripEcho(raw: string, cmd: string): string {
  const SENTINEL_LINE = /__SSH_DONE_[0-9a-f]+__/
  const lines = raw.split(/\r?\n/).map((line) => line.replace(/\r/g, "").trimEnd())
  return lines.filter((line) => line !== "" && !line.includes(cmd) && !SENTINEL_LINE.test(line)).join("\n")
}

/**
 * 剥离 ANSI 转义序列（颜色、光标控制等）
 * @param s 原始字符串
 * @returns 清洗后的纯文本
 */
export function cleanAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "")
}

/**
 * 合并同一行内的 \r / ANSI 清行覆盖（进度条/旋转动画）：保留每行最后一次刷新状态，
 * 避免 "下载 1%\r下载 2%\r...\r下载 100%" 累积成巨量碎片输出
 * 识别 \r 与 ANSI 清行（ESC[2K / ESC[K）+ 光标归位（ESC[G）作为行覆盖分隔符
 * @param s 原始输出（含 ANSI 或已清洗均可）
 * @returns 合并覆盖后的文本（\r\n 正常换行保留）
 */
export function collapseCarriage(s: string): string {
  // 覆盖分隔符：裸 \r 或 ANSI 清行/光标归位序列（ESC[2K、ESC[K、ESC[G）
  const OVERWRITE = /\r|\x1b\[[0-9]*[KG]/
  // 按 \r\n 拆成行（保留正常 CRLF 换行），行内按覆盖分隔符拆分取最后一段
  return s
    .split(/\r\n/)
    .map((line) => {
      const segs = line.split(OVERWRITE).filter((seg) => seg !== "")
      if (segs.length <= 1) return line
      return segs[segs.length - 1]
    })
    .join("\n")
}

/**
 * 剥离尾部 shell 提示符残留（如 "5cb08b77db01:~$ "、"user@host:~/dir$ "、"root@server:/etc#"）
 * @param s 清洗后文本
 * @returns 剥离尾部提示符后的文本
 */
export function stripPrompt(s: string): string {
  return s
    .replace(/(?:^|[\r\n])\s*(?:[\w.-]+@)?[\w.-]+:[^\r\n]*[$#%] ?(?=[\r\n]|$)/g, "")
    .trim()
}

/**
 * 时间戳格式化为 yyyy-MM-dd HH:mm:ss
 * @param ts 毫秒时间戳
 * @returns 格式化时间
 */
export function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
