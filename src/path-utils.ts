// 本地路径工具：插件进程本机路径的 ~ 展开（payload / transfer 共用，避免重复实现）

import { homedir } from "node:os"
import { join } from "node:path"

/**
 * 展开开头的 ~（"~" / "~/" / "~\\"）为当前用户 home 目录；其他路径原样返回。
 * 仅用于插件进程本机路径；远端路径的 ~ 由 SFTP realpath(".") 展开（见 transfer.ts）。
 * @param path 用户传入的文件路径
 * @returns 展开后的路径
 */
export function expandLocalHome(path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2))
  return path
}
