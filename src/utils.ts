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
 * 剔除 PTY 回显的命令行（首行包含命令文本，可能带提示符前缀）
 * @param raw 原始输出
 * @param cmd 已发送命令（组合串）
 * @returns 剔除回显后的输出
 */
export function stripEcho(raw: string, cmd: string): string {
  const lines = raw.split(/\r?\n/)
  if (lines.length > 0 && lines[0].includes(cmd)) {
    lines.shift()
  }
  return lines.join("\n")
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
 * 终端记录转义为 HTML 文本
 * @param s 原始文本
 * @returns HTML 转义文本
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

/**
 * 生成自包含可滚动的终端记录 HTML（黑底绿字等宽，浏览器打开即看）
 * @param transcript 完整终端记录
 * @param title 页面标题
 * @returns 完整 HTML 字符串
 */
export function buildTerminalHtml(transcript: string, title: string): string {
  const body = escapeHtml(transcript)
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  html, body { margin: 0; height: 100%; background: #0d1117; color: #c9d1d9; }
  header { position: sticky; top: 0; background: #161b22; padding: 10px 16px; border-bottom: 1px solid #30363d; font-family: system-ui, sans-serif; }
  header h1 { margin: 0; font-size: 14px; color: #e6edf3; font-weight: 600; }
  pre { margin: 0; padding: 16px; font-family: "Cascadia Code", Consolas, "Courier New", monospace; font-size: 13px; line-height: 1.5; white-space: pre; overflow: auto; height: calc(100% - 44px); box-sizing: border-box; color: #2fbf71; }
</style>
</head>
<body>
<header><h1>${escapeHtml(title)}</h1></header>
<pre>${body}</pre>
</body>
</html>`
}

/**
 * 字符串转 data URL
 * @param content 内容
 * @param mime MIME 类型
 * @returns data URL
 */
export function toDataUrl(content: string, mime: string): string {
  return `data:${mime};charset=utf-8,${encodeURIComponent(content)}`
}
