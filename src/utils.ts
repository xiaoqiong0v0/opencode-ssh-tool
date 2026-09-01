// 工具函数：哨兵生成、回显剔除、ANSI 清洗、终端记录 HTML 渲染

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
 * @param raw 原始输出
 * @param cmd 已发送命令（组合串）
 * @returns 剔除回显后的输出
 */
export function stripEcho(raw: string, cmd: string): string {
  const lines = raw.split(/\r?\n/).map((line) => line.replace(/\r/g, "").trimEnd())
  return lines.filter((line) => line !== "" && !line.includes(cmd)).join("\n")
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
