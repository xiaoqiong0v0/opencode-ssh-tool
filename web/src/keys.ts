// 直接输入的按键 → 终端字节序列映射（纯逻辑，集中定义，便于单测）
//
// 口径：发送的是**真实控制字节**（如 0x7f、0x09、ESC 引导的序列），不是 `\x7f` 这类转义字面量。
// 后端 send() 走通用解码（见 src/escapes.ts）：真实字节不含反斜杠，逐字节原样到达 PTY；
// 转义文本（模型侧 term_send "\x03"）由同一解码规则处理，两条路径口径一致。
// 对照 xterm.js 默认键表：特殊键/导航键 → ANSI 序列，Ctrl+字母 → 0x01..0x1a，其余可打印字符原样。

/** ESC 引导序列前缀 */
export const ESC = "\x1b"
/** Backspace 终端要求 DEL(0x7f)，不是 BS(0x08) */
export const DEL = "\x7f"
/** 回车（提交行） */
export const CR = "\r"
/** Tab */
export const TAB = "\t"

/** 映射所需的最小键盘事件字段（便于在 Node 中用普通对象构造测试输入） */
export interface KeyEventLike {
  key: string
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  metaKey?: boolean
}

/** 无修饰键（或仅 Shift）时的特殊键 → 终端字节序列（对照 xterm.js 默认键表） */
export const KEY_SEQUENCES: Record<string, string> = {
  Enter: CR,
  Escape: ESC,
  Backspace: DEL,
  Tab: TAB,
  " ": " ",
  Spacebar: " ",
  Delete: ESC + "[3~",
  Insert: ESC + "[2~",
  ArrowUp: ESC + "[A",
  ArrowDown: ESC + "[B",
  ArrowRight: ESC + "[C",
  ArrowLeft: ESC + "[D",
  Home: ESC + "[H",
  End: ESC + "[F",
  PageUp: ESC + "[5~",
  PageDown: ESC + "[6~",
  F1: ESC + "OP",
  F2: ESC + "OQ",
  F3: ESC + "OR",
  F4: ESC + "OS",
  F6: ESC + "[17~",
  F7: ESC + "[18~",
  F8: ESC + "[19~",
  F9: ESC + "[20~",
  F10: ESC + "[21~",
}

/** 带 Ctrl/Alt 时的导航键：CSI 1;<mod> <final>（mod=1+shift+2*alt+4*ctrl） */
export const CSI_LETTER: Record<string, string> = {
  ArrowUp: "A", ArrowDown: "B", ArrowRight: "C", ArrowLeft: "D", Home: "H", End: "F",
}
/** 带 Ctrl/Alt 时的导航键：CSI <n>;<mod> ~ */
export const CSI_TILDE: Record<string, number> = {
  Insert: 2, Delete: 3, PageUp: 5, PageDown: 6,
}
/** Ctrl+标点的控制字节（xterm 默认） */
export const CTRL_PUNCT: Record<string, number> = { "@": 0, "[": 27, "\\": 28, "]": 29, "^": 30, "_": 31 }

/**
 * 浏览器必备快捷键：命中则**不拦截**（不 preventDefault），交还浏览器默认行为。
 * 否则页面聚焦时用户无法刷新（F5/Ctrl+R/Ctrl+Shift+R）、打开开发者工具（F12/Ctrl+Shift+I）或关闭标签（Ctrl+W）。
 * @param ev keydown 事件
 * @returns 是否应放行给浏览器
 */
export function isBrowserShortcut(ev: KeyEventLike): boolean {
  if (ev.key === "F5" || ev.key === "F11" || ev.key === "F12") return true
  if (!(ev.ctrlKey || ev.metaKey)) return false
  const k = ev.key.toLowerCase()
  if (k === "r") return true
  if (ev.shiftKey && (k === "i" || k === "j" || k === "c")) return true
  return k === "w" || k === "t" || k === "n"
}

/**
 * 键盘事件映射为终端字节序列（纯函数，无副作用）。
 * 特殊键/导航键 → ANSI 序列，Ctrl+字母 → 0x01..0x1a，其余可打印字符原样；
 * 浏览器快捷键与不支持的组合返回 null（不拦截）。
 * @param ev keydown 事件
 * @returns 要发送的字节串，或 null（不映射）
 */
export function mapKeystroke(ev: KeyEventLike): string | null {
  if (isBrowserShortcut(ev)) return null
  // Cmd/Win 组合交给系统/浏览器，不劫持
  if (ev.metaKey) return null
  const key = ev.key
  // Ctrl+字母/标点 → 控制字节（Ctrl+C=0x03 中断、Ctrl+D=0x04、Ctrl+Z=0x1a 等）
  if (ev.ctrlKey && !ev.altKey && key.length === 1) {
    const c = key.toLowerCase()
    if (c >= "a" && c <= "z") return String.fromCharCode(c.charCodeAt(0) - 96)
    if (c in CTRL_PUNCT) return String.fromCharCode(CTRL_PUNCT[c])
    return null
  }
  // Ctrl/Alt 修饰的导航键 → CSI 修饰形式（Ctrl+↑ = ESC[1;5A 之类）
  if ((ev.ctrlKey || ev.altKey) && !ev.shiftKey) {
    const mod = 1 + (ev.altKey ? 2 : 0) + (ev.ctrlKey ? 4 : 0)
    if (key in CSI_LETTER) return ESC + "[1;" + mod + CSI_LETTER[key]
    if (key in CSI_TILDE) return ESC + "[" + CSI_TILDE[key] + ";" + mod + "~"
    return null
  }
  if (ev.altKey) return null
  // Shift+Tab
  if (key === "Tab" && ev.shiftKey) return ESC + "[Z"
  const seq = KEY_SEQUENCES[key]
  if (seq !== undefined) return seq
  if (key.length === 1) return key
  return null
}
