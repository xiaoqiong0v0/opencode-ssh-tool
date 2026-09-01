// 会话记录存储：命令+输出 消息对，按对数限制，单条超阈值落盘

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomBytes } from "node:crypto"

/** 消息对：命令 + 输出（内存或落盘引用） */
export interface HistoryPair {
  command: string
  output?: string // 内存内输出（小）
  file?: string // 落盘路径（单条超阈值时）
  size: number // 输出字节数
  ts: number
}

/** 消息对存储（按对数限制，超出移除最旧） */
export class SessionHistory {
  private pairs: HistoryPair[] = []
  private readonly spillDir: string

  /**
   * @param maxMessages 保留消息对数（最小 1，保留最新）
   * @param spillThreshold 单条输出超此字节数时写文件
   */
  constructor(
    private readonly maxMessages: number,
    private readonly spillThreshold: number,
  ) {
    this.spillDir = mkdtempSync(join(tmpdir(), "ssh-tool-"))
  }

  /**
   * 追加一条命令+输出对；超阈值写文件；超对数移除最旧
   * @param command 命令
   * @param output 输出
   */
  append(command: string, output: string): void {
    const ts = Date.now()
    let pair: HistoryPair

    if (output.length > this.spillThreshold) {
      // 单条超大 → 落盘，内存只存引用
      const file = join(this.spillDir, `${ts}-${randomBytes(4).toString("hex")}.out`)
      writeFileSync(file, output, "utf8")
      pair = { command, file, size: output.length, ts }
    } else {
      pair = { command, output, size: output.length, ts }
    }

    this.pairs.push(pair)

    // 超对数：移除最旧（含清理其落盘文件）
    while (this.pairs.length > Math.max(1, this.maxMessages)) {
      const oldest = this.pairs.shift()
      if (oldest?.file) {
        try {
          rmSync(oldest.file, { force: true })
        } catch {
          /* 忽略 */
        }
      }
    }
  }

  /**
   * 当前保留的所有消息对
   * @returns 消息对数组（旧→新）
   */
  getPairs(): HistoryPair[] {
    return [...this.pairs]
  }

  /**
   * 读取某对输出（内存或落盘文件）
   * @param pair 消息对
   * @returns 输出文本
   */
  readOutput(pair: HistoryPair): string {
    if (pair.output !== undefined) return pair.output
    if (pair.file) {
      try {
        return readFileSync(pair.file, "utf8")
      } catch {
        return `[无法读取落盘文件: ${pair.file}]`
      }
    }
    return ""
  }

  /**
   * 当前消息对数
   * @returns 对数
   */
  totalPairs(): number {
    return this.pairs.length
  }

  /**
   * 释放资源：删除落盘目录
   */
  dispose(): void {
    try {
      rmSync(this.spillDir, { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
  }
}
