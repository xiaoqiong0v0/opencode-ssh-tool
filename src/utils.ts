// 工具函数：哨兵生成、注入剔除、模型文本清理、ANSI 清洗、CR 覆盖合并、提示符剥离

import { randomBytes } from "node:crypto"

/** 单个 ANSI 序列片段（CSI 光标/颜色控制，如 ESC[?2004h） */
const ANSI_CHUNK = "\\x1b\\[[0-9;?]*[a-zA-Z]"
/** ANSI 或普通空白（制表/空格）构成的间隙，可插在任意两个字符/词之间（不跨换行） */
const GAP = `(?:(?:${ANSI_CHUNK})|[ \\t])*`
/** 正则转义文本 */
const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
/** 把字符串每个字符用 GAP 串起来（容忍 bash 回显时在字符间隙插入 ANSI 序列） */
const interleave = (s: string): string => [...escRe(s)].join(GAP)

/**
 * 生成命令完成哨兵标记（随机后缀防撞词）
 * @returns 哨兵字符串
 */
export function genSentinel(): string {
  return `__SSH_DONE_${randomBytes(6).toString("hex")}__`
}

/**
 * 从命令捕获窗口原始字节流中剔除我们注入的哨兵痕迹（其余内容逐字节保真）：
 * 1. 命令回显行末尾拼接的 `; echo SENTINEL` 片段（保留原命令本体，如 `cmd; echo SENTINEL` → `cmd`）
 * 2. 若整行恰为哨兵本体（`echo SENTINEL` 的执行输出），整行删除
 * 不 trim、不删空行、不折叠换行、不动 ANSI —— 存储层/渲染层拿到的是接近真实终端屏幕的字节流，
 * 由 web 端 TermScreen 忠实渲染，由 toModelText() 在给模型时再做清理。
 * @param raw 捕获窗口原始输出（含哨兵）
 * @param sentinel 本次注入的哨兵串
 * @returns 剔除注入痕迹后的原始字节流（哨兵处可能残留空行，属正常）
 */
export function stripSentinel(raw: string, sentinel: string): string {
  // 命令回显尾部片段：`; echo <哨兵>`，分号、echo 词内/词间、哨兵字符间隙均可插 ANSI 或空白
  const TAIL = new RegExp(`;${GAP}${interleave("echo")}${GAP}${interleave(sentinel)}${GAP}`, "g")
  // 哨兵独立成行：行首（或换行后）→ 哨兵 → 行尾换行，整行连同其换行删除（保留前置换行，避免行粘连）
  const STANDALONE = new RegExp(`(^|[\\r\\n])${GAP}${interleave(sentinel)}${GAP}\\r?\\n`, "gm")
  return raw.replace(TAIL, "").replace(STANDALONE, (_m, lead: string) => lead)
}

/**
 * 把原始终端流转为给模型看的干净文本：合并 \r/ANSI 行内覆盖（进度条取末帧）、剥离 ANSI 控制序列、
 * 逐行去尾空白并剔除空行。仅做无损化简，不删除任何命令/程序实质输出内容。
 * @param raw 已剔除哨兵的原始字节流（stripSentinel 输出）
 * @returns 纯文本输出（供模型消费 / exec 返回值 / read 命令）
 */
export function toModelText(raw: string): string {
  return cleanAnsi(collapseCarriage(raw))
    .split(/\r?\n/)
    .map((l) => l.replace(/\r/g, "").trimEnd())
    .filter((l) => l !== "")
    .join("\n")
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
