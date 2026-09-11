// 会话记录存储：命令+输出 消息对，全部存文件（持久化，重启不丢），按对数限制

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** 消息对元数据（输出存文件，内存只存引用） */
export interface HistoryPair {
  command: string
  /** 输出文件路径（持久化） */
  file: string
  size: number
  /** 命令输入时刻 */
  ts: number
  /** 命令完成时刻（标记出现时） */
  endTs: number
  /** 序号（文件顺序） */
  seq: number
}

/** 消息对存储：目录 <cacheRoot>/<sessionID>/，每对一文件，超对数删最旧 */
export class SessionHistory {
  private pairs: HistoryPair[] = []
  private readonly dir: string
  private nextSeq = 1

  /**
   * @param cacheRoot 插件缓存根目录（如 ~/.opencode/plugins-cache/opencode-ssh-tool）
   * @param sessionID opencode 会话 ID（用作子目录名）
   * @param maxMessages 保留消息对数（最小 1，保留最新）
   */
  constructor(
    cacheRoot: string,
    sessionID: string,
    private readonly maxMessages: number,
  ) {
    this.dir = join(cacheRoot, sessionID)
    mkdirSync(this.dir, { recursive: true })
    this._restore()
  }

  /** 从已有文件恢复索引（重启同 sessionID 可恢复历史） */
  private _restore(): void {
    let files: string[]
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith(".json"))
    } catch {
      files = []
    }
    files.sort()
    for (const f of files) {
      try {
        const data = JSON.parse(readFileSync(join(this.dir, f), "utf8")) as {
          command: string
          output?: string
          ts: number
          endTs?: number
        }
        const seq = parseInt(f.split("-")[0] ?? "0", 10) || this.nextSeq
        const size = data.output?.length ?? 0
        this.pairs.push({ command: data.command, file: join(this.dir, f), size, ts: data.ts, endTs: data.endTs ?? data.ts, seq })
        if (seq >= this.nextSeq) this.nextSeq = seq + 1
      } catch {
        /* 跳过损坏文件 */
      }
    }
    this.pairs.sort((a, b) => a.seq - b.seq)
    this._trim()
  }

  /**
   * 追加一条命令+原始流输出对（写文件），超对数移除最旧
   * @param command 命令
   * @param output 原始终端流（已去哨兵注入，未做其他清理），供 web 忠实渲染、模型按需 toModelText
   * @param startTs 命令输入时刻（默认取当前时间）；用于展示命令发起时间
   * @param endTs 命令完成时刻（标记出现时；默认取当前时间）
   */
  append(command: string, output: string, startTs?: number, endTs?: number): void {
    const ts = startTs ?? Date.now()
    const end = endTs ?? Date.now()
    const seq = this.nextSeq++
    const file = join(this.dir, `${String(seq).padStart(6, "0")}-${ts}.json`)
    writeFileSync(file, JSON.stringify({ command, output, ts, endTs: end }), "utf8")
    this.pairs.push({ command, file, size: output.length, ts, endTs: end, seq })
    this._trim()
  }

  /** 超对数：删除最旧文件并移除索引 */
  private _trim(): void {
    while (this.pairs.length > Math.max(1, this.maxMessages)) {
      const oldest = this.pairs.shift()
      if (oldest) {
        try {
          rmSync(oldest.file, { force: true })
        } catch {
          /* 忽略 */
        }
      }
    }
  }

  /**
   * 当前保留的所有消息对（旧→新）
   * @returns 消息对数组
   */
  getPairs(): HistoryPair[] {
    return [...this.pairs]
  }

  /**
   * 读取某对输出（从文件，返回原始流，已去哨兵注入）
   * @param pair 消息对
   * @returns 原始终端流（含 ANSI 颜色，不含哨兵注入）
   */
  readOutput(pair: HistoryPair): string {
    try {
      const data = JSON.parse(readFileSync(pair.file, "utf8")) as { output?: string }
      return data.output ?? ""
    } catch {
      return `[cannot read history file: ${pair.file}]`
    }
  }

  /**
   * 当前消息对数
   * @returns 对数
   */
  totalPairs(): number {
    return this.pairs.length
  }

  /**
   * 清空历史记录：删除所有文件 + 重置内存
   */
  clear(): void {
    for (const p of this.pairs) {
      try { rmSync(p.file, { force: true }) } catch { /* 忽略 */ }
    }
    this.pairs = []
    this.nextSeq = 1
  }

  /**
   * 会话关闭：删除整个会话目录（含所有消息文件）
   */
  dispose(): void {
    try {
      rmSync(this.dir, { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
  }
}
