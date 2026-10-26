// 文件传输（v1：仅 SSH/SFTP）：路径校验、独占创建/临时文件 + rename、overwrite/mkdir 语义、全链路超时与清理
//
// 设计要点：
// - 只走 SFTP subsystem；不使用 exec / scp / base64 / PTY 传文件；内容按二进制流式传输；
// - 默认（无 overwrite）使用**独占创建**（远端 flags "wx" / 本地 fs flags "wx"），目标存在即失败，
//   不覆盖、不自动改名/备份；只有 overwrite=true 才走"同目录临时文件 + rename"提交；
// - 默认不建父目录（parent_missing），mkdir=true 才递归创建；
// - 只传普通文件；目录 / 符号链接一律拒绝；
// - 整个传输（开通道后的路径检查/建目录/读写/提交）共用一个 deadline；超时中止 SFTP 通道，
//   且不再主动发起新的 rename/commit（已发出的 rename 仍可能被服务端执行）；
// - overwrite 备份旧目标后若新文件未就位，本地/远端都尽力回滚旧目标；回滚失败时错误 detail 给出备份路径。
// - 传输内容不进入模型上下文与日志：本模块不打印任何文件内容，只回传路径/实际字节/耗时。
//
// 分层：本文件只依赖可注入的最小 SFTP 接口（TransferSftp），不依赖 SshSession，
// 便于单测用 fake SFTP 覆盖；SshSession 负责开/关 SFTP subsystem、通道 error 监听与串行化（见 session.ts）。

import { randomUUID } from "node:crypto"
import { createReadStream as createLocalReadStream, createWriteStream as createLocalWriteStream } from "node:fs"
import { type FileHandle, lstat as lstatLocal, mkdir as mkdirLocal, open as openLocal, rename as renameLocal, stat as statLocal, unlink as unlinkLocal } from "node:fs/promises"
import { basename, dirname, join, posix } from "node:path"
import type { Readable, Writable } from "node:stream"
import type { ReadStreamOptions, Stats, WriteStreamOptions } from "ssh2"

import {
  MAX_TRANSFER_BYTES,
  TRANSFER_COMMIT_MIN_REMAINING_MS,
  TRANSFER_CLEANUP_TIMEOUT_MS,
  TRANSFER_TIMEOUT_MS,
} from "./constants.js"
import { expandLocalHome } from "./path-utils.js"

/** 传输错误机器码（展示文案由 index.ts 按语言映射，不在本模块硬编码可见文本） */
export type TransferErrorCode =
  | "exists"
  | "local_missing"
  | "local_is_dir"
  | "remote_missing"
  | "remote_is_dir"
  | "symlink"
  | "parent_missing"
  | "too_large"
  | "sftp_unavailable"
  | "timeout"
  | "io"
  | "unsupported"
  | "ssh_only"
  | "denied"
  | "tilde_user"
  | "remote_path_backslash"

/**
 * 传输错误：只携带机器码 + 路径 + 内部诊断信息，展示文案由调用方按语言生成。
 */
export class TransferError extends Error {
  readonly code: TransferErrorCode
  /** 出错涉及的路径（本地或远端，供文案回显） */
  readonly path?: string
  /** 内部诊断信息（仅用于日志/io 文案，不是可见文案本身） */
  readonly detail?: string

  /**
   * @param code 机器码
   * @param path 出错路径
   * @param detail 内部诊断信息
   */
  constructor(code: TransferErrorCode, path?: string, detail?: string) {
    super(detail ?? code)
    this.name = "TransferError"
    this.code = code
    this.path = path
    this.detail = detail
  }
}

/** 本模块使用的最小 SFTP 接口（与 ssh2 SFTPWrapper 结构兼容，单测可注入 fake） */
export interface TransferSftp {
  stat(path: string, callback: (err: Error | undefined, stats: Stats) => void): void
  lstat(path: string, callback: (err: Error | undefined, stats: Stats) => void): void
  mkdir(path: string, callback: (err?: Error | null) => void): void
  rename(srcPath: string, destPath: string, callback: (err?: Error | null) => void): void
  unlink(path: string, callback: (err?: Error | null) => void): void
  realpath(path: string, callback: (err: Error | undefined, absPath: string) => void): void
  createReadStream(path: string, options?: ReadStreamOptions): Readable
  createWriteStream(path: string, options?: WriteStreamOptions): Writable
  end(): void
  destroy(): void
}

/** 传输结果（成功时返回；不含文件内容） */
export interface TransferResult {
  /** 实际使用的插件进程本机路径（~ 已展开） */
  localPath: string
  /** 实际使用的远端路径（~/ 已由 SFTP 展开为绝对路径） */
  remotePath: string
  /** 实际读/写字节数（来自流计数，不使用传输前 stat 值） */
  bytes: number
  /** 耗时（毫秒） */
  duration: number
}

/** 上传参数（sftp 由 SshSession 注入） */
export interface UploadOptions {
  sftp: TransferSftp
  localPath: string
  remotePath: string
  /** 目标存在时是否允许覆盖（默认 false = 独占创建，直接失败） */
  overwrite?: boolean
  /** 父目录不存在时是否递归创建（默认 false = parent_missing） */
  mkdir?: boolean
  /** 整个传输的超时（毫秒，默认 TRANSFER_TIMEOUT_MS） */
  timeoutMs?: number
  /** 大小上限（字节，默认 MAX_TRANSFER_BYTES） */
  maxBytes?: number
  /** 外部中止信号（会话层通道错误/超时注入；中止后立即拒绝且不再提交） */
  abortSignal?: AbortSignal
  /**
   * 进度回调（已传字节数 / 总字节数）：拿到本地 stat 后先回调 `(0, size)`，
   * 之后每累计一块回调一次；回调抛错会被吞掉，不影响传输本身。
   */
  onProgress?: (bytes: number, total: number) => void
}

/** 下载参数（sftp 由 SshSession 注入） */
export interface DownloadOptions {
  sftp: TransferSftp
  remotePath: string
  localPath: string
  /** 本地目标存在时是否允许覆盖（默认 false = 独占创建，直接失败） */
  overwrite?: boolean
  /** 本地父目录不存在时是否递归创建（默认 false = parent_missing） */
  mkdir?: boolean
  /** 整个传输的超时（毫秒，默认 TRANSFER_TIMEOUT_MS） */
  timeoutMs?: number
  /** 大小上限（字节，默认 MAX_TRANSFER_BYTES） */
  maxBytes?: number
  /** 外部中止信号（会话层通道错误/超时注入；中止后立即拒绝且不再提交） */
  abortSignal?: AbortSignal
  /** 进度回调（已传字节数 / 总字节数）；语义同 UploadOptions.onProgress */
  onProgress?: (bytes: number, total: number) => void
}

/** 可执行文件传输的会话能力（仅 SshSession 实现；LocalSession 明确没有） */
export interface TransferCapableSession {
  uploadFile(opts: Omit<UploadOptions, "sftp">): Promise<TransferResult>
  downloadFile(opts: Omit<DownloadOptions, "sftp">): Promise<TransferResult>
}

/** 文件属性最小子集（本地 fs.Stats 与 ssh2 Stats 均满足） */
type StatLike = Pick<Stats, "size" | "isDirectory" | "isFile" | "isSymbolicLink">

/**
 * 判定错误是否为"文件不存在"（SFTP 状态码 2 / 本地 ENOENT / 文本兜底）。
 * @param err 原始错误
 * @returns true 表示不存在
 */
function isNoSuchFile(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null | undefined
  if (e?.code === 2 || e?.code === "ENOENT") return true
  return typeof e?.message === "string" && /no such file/i.test(e.message)
}

/**
 * 判定错误是否为"目标已存在"（本地独占创建 EEXIST；部分 SFTP 服务端 EXCL 冲突）。
 * @param err 原始错误
 * @returns true 表示已存在
 */
function isAlreadyExists(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null | undefined
  return e?.code === "EEXIST" || (typeof e?.message === "string" && /file already exists/i.test(e.message))
}

/**
 * 包装 SFTP 回调为 Promise（stat/lstat）。
 * @param invoke 执行回调式调用的函数
 * @returns 属性
 */
function statP(invoke: (cb: (err: Error | undefined, stats: Stats) => void) => void): Promise<Stats> {
  return new Promise<Stats>((resolve, reject) => {
    invoke((err, stats) => (err ? reject(err) : resolve(stats)))
  })
}

/**
 * 包装 SFTP 回调为 Promise（无返回值操作）。
 * @param invoke 执行回调式调用的函数
 * @returns 完成 Promise
 */
function voidP(invoke: (cb: (err?: Error | null) => void) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    invoke((err) => (err ? reject(err) : resolve()))
  })
}

/**
 * 超时包装：到点调用 onTimeout（中止通道/流）并以 timeout 拒绝；原 Promise 后到结果被忽略。
 * @param work 待等待的 Promise
 * @param timeoutMs 超时毫秒
 * @param onTimeout 超时回调（可抛错，内部吞掉）
 * @returns work 的结果
 */
function withTimeout<T>(work: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        onTimeout()
      } catch {
        /* 中止失败不影响超时报错 */
      }
      reject(new TransferError("timeout", undefined, `timed out after ${timeoutMs}ms`))
    }, Math.max(1, timeoutMs))
    work.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/**
 * 传输级 deadline：整条传输共用一份剩余时间；超时/外部中止统一中止（SFTP 通道 + 活动流），
 * 并在每次关键提交前用 check() 保证"中止后不再发起新的 rename/commit"。
 * 外部中止（会话层通道 error / 开通道超时）走 abort()，让正在等待的 SFTP 回调立即失败，
 * 避免 job 在已销毁的通道上挂满整条传输超时。
 */
class TransferDeadline {
  private readonly expiresAt: number
  private readonly timeoutMs: number
  private timedOut = false
  private abortError: TransferError | null = null
  private abortReject: ((err: TransferError) => void) | null = null
  private abortPromise: Promise<never> | null = null
  private readonly aborts = new Set<() => void>()

  /**
   * @param timeoutMs 传输总超时（毫秒）
   */
  constructor(timeoutMs: number) {
    this.timeoutMs = Math.max(1, timeoutMs)
    this.expiresAt = Date.now() + this.timeoutMs
  }

  /** 是否已超时（含已中止或已过截止时刻） */
  get expired(): boolean {
    return this.timedOut || Date.now() >= this.expiresAt
  }

  /**
   * 注册中止动作（通道/流 destroy）；返回注销函数。
   * @param fn 中止动作
   * @returns 注销函数
   */
  onAbort(fn: () => void): () => void {
    if (this.timedOut) {
      try { fn() } catch { /* 忽略 */ }
      return () => undefined
    }
    this.aborts.add(fn)
    return () => { this.aborts.delete(fn) }
  }

  /**
   * 中止本次传输（超时与外部通道错误共用）：执行全部中止动作，并让进行中的 run() 立即拒绝（幂等）。
   * @param error 中止原因；缺省为 timeout
   */
  abort(error?: TransferError): void {
    if (this.timedOut) return
    this.timedOut = true
    this.abortError = error ?? this.timeoutError()
    for (const fn of [...this.aborts]) {
      try { fn() } catch { /* 单个中止失败不影响其他 */ }
    }
    const reject = this.abortReject
    this.abortReject = null
    if (reject) {
      try { reject(this.abortError) } catch { /* 忽略 */ }
    }
  }

  /** 标记超时并执行全部中止动作（幂等） */
  markTimeout(): void {
    this.abort(this.timeoutError())
  }

  /** 剩余毫秒（至少 1，供 setTimeout 使用） */
  remaining(): number {
    return Math.max(1, this.expiresAt - Date.now())
  }

  /**
   * 关键点检查：已中止/超时则中止并抛对应错误（用于提交前，确保不再发起新的 rename）。
   * @throws {TransferError} code=timeout 或外部中止原因
   */
  check(): void {
    if (!this.expired) return
    if (!this.timedOut) this.markTimeout()
    throw this.abortError ?? this.timeoutError()
  }

  /**
   * 在剩余时间内执行一个异步操作；超时中止整条传输并抛 timeout；外部中止立即拒绝。
   * @param work 待执行操作
   * @returns 操作结果
   */
  async run<T>(work: Promise<T>): Promise<T> {
    this.check()
    return withTimeout(Promise.race([work, this.abortSignal()]), this.remaining(), () => this.markTimeout())
  }

  /** 惰性创建"已被中止"的拒绝 Promise（与 work 竞速，使等待中的回调立即失败） */
  private abortSignal(): Promise<never> {
    // check() 与本调用之间可能刚好发生中止：直接返回已拒绝的 Promise
    if (this.timedOut) return Promise.reject(this.abortError ?? this.timeoutError())
    if (!this.abortPromise) {
      this.abortPromise = new Promise<never>((_resolve, reject) => { this.abortReject = reject })
    }
    return this.abortPromise
  }

  /** 构造 timeout 错误（带总超时说明） */
  private timeoutError(): TransferError {
    return new TransferError("timeout", undefined, `timed out after ${this.timeoutMs}ms`)
  }
}

/** 远端 stat（跟随符号链接；用于父目录判定） */
function remoteStat(deadline: TransferDeadline, sftp: TransferSftp, path: string): Promise<Stats> {
  return deadline.run(statP((cb) => sftp.stat(path, cb)))
}

/** 远端 lstat（不跟随符号链接；用于目标类型判定） */
function remoteLstat(deadline: TransferDeadline, sftp: TransferSftp, path: string): Promise<Stats> {
  return deadline.run(statP((cb) => sftp.lstat(path, cb)))
}

/** 远端 lstat：不存在返回 null，其他错误上抛（timeout 不当作不存在） */
async function remoteLstatOrNull(deadline: TransferDeadline, sftp: TransferSftp, path: string): Promise<Stats | null> {
  try {
    return await remoteLstat(deadline, sftp, path)
  } catch (e) {
    if (e instanceof TransferError && e.code === "timeout") throw e
    if (isNoSuchFile(e)) return null
    throw e
  }
}

/**
 * 失败路径上的远端 lstat 探测：只受清理预算限制，不占用剩余总 deadline
 * （通道异常/超时后回调可能永不返回，用剩余 10 分钟会把错误路径挂死）。
 * @param sftp SFTP 实例
 * @param path 远端路径
 * @returns 属性；不存在/探测失败/超时均返回 null（调用方据此抛原始错误）
 */
async function remoteLstatOrNullWithin(sftp: TransferSftp, path: string): Promise<Stats | null> {
  try {
    return await withTimeout(statP((cb) => sftp.lstat(path, cb)), TRANSFER_CLEANUP_TIMEOUT_MS, () => undefined)
  } catch {
    return null
  }
}

/**
 * 把会话层中止信号接入传输 deadline：通道 error / 开通道超时时立即中止本次传输。
 * @param signal 外部中止信号（可空）
 * @param deadline 传输 deadline
 * @returns 注销函数
 */
function registerExternalAbort(signal: AbortSignal | undefined, deadline: TransferDeadline): () => void {
  if (!signal) return () => undefined
  const onAbort = (): void => {
    deadline.abort(signal.reason instanceof TransferError ? signal.reason : new TransferError("timeout", undefined, "transfer aborted"))
  }
  if (signal.aborted) {
    onAbort()
    return () => undefined
  }
  signal.addEventListener("abort", onAbort, { once: true })
  return () => { signal.removeEventListener("abort", onAbort) }
}

/** 本地 lstat：不存在返回 null，其他错误上抛 */
async function localLstatOrNull(deadline: TransferDeadline, path: string): Promise<StatLike | null> {
  try {
    return await deadline.run(lstatLocal(path))
  } catch (e) {
    if (e instanceof TransferError && e.code === "timeout") throw e
    if (isNoSuchFile(e)) return null
    throw e
  }
}

/**
 * 本地独占创建（flags "wx"）：成功即代表文件由本次创建，失败可准确区分 exists。
 * 用 FileHandle 而不是 createWriteStream 的懒 open，避免"失败发生在 open 事件之前"时
 * 无法判断本地部分文件是否由本次创建（清理可靠性）。
 * @param deadline 传输 deadline
 * @param path 本地目标
 * @returns 已打开的 FileHandle
 */
async function openLocalExclusive(deadline: TransferDeadline, path: string): Promise<FileHandle> {
  try {
    return await deadline.run(openLocal(path, "wx"))
  } catch (e) {
    if (e instanceof TransferError) throw e
    if (isAlreadyExists(e)) throw new TransferError("exists", path)
    throw e
  }
}

/**
 * 校验为普通文件：符号链接优先识别（lstat 才看得到），目录单独报，其余类型统一 unsupported。
 * @param stats 文件属性
 * @param kind 端（本地/远端，决定错误码）
 * @param path 路径（错误回显）
 */
function assertRegularFile(stats: StatLike, kind: "local" | "remote", path: string): void {
  if (stats.isSymbolicLink()) throw new TransferError("symlink", path)
  if (stats.isDirectory()) throw new TransferError(kind === "local" ? "local_is_dir" : "remote_is_dir", path)
  if (!stats.isFile()) throw new TransferError("unsupported", path)
}

/**
 * 远端路径策略校验：Windows 反斜杠盘符路径（C:\a\b）明确拒绝；
 * 正斜杠盘符路径（C:/a/b）按 POSIX 语义处理（parent = C:/a）。
 * @param input 用户传入的远端路径
 * @returns 原路径（便于链式调用）
 */
function assertRemotePathStyle(input: string): string {
  if (/^[A-Za-z]:\\/.test(input)) throw new TransferError("remote_path_backslash", input)
  return input
}

/**
 * 展开远端路径的 ~（不经过 shell）：
 * - "~" / "~/..." 用 SFTP realpath(".") 得到登录 home 再拼接；
 * - "~user/..." 明确不支持（依赖服务端扩展，v1 不猜）；
 * - 绝对/相对路径原样返回（相对路径由 SFTP 服务端按 home 解析）。
 * @param deadline 传输 deadline
 * @param sftp SFTP 实例
 * @param input 用户传入的远端路径
 * @returns 可交给 SFTP 的路径
 */
async function expandRemoteHome(deadline: TransferDeadline, sftp: TransferSftp, input: string): Promise<string> {
  assertRemotePathStyle(input)
  if (input === "~") return deadline.run(realpathP(sftp, "."))
  if (input.startsWith("~/")) {
    const home = await deadline.run(realpathP(sftp, "."))
    return posix.join(home, input.slice(2))
  }
  if (input.startsWith("~")) {
    throw new TransferError("tilde_user", input, "~user paths are not supported; use ~/ or an absolute path")
  }
  return input
}

/** 远端 realpath（SFTP 回调包装，不单独计超时，由调用方 deadline.run） */
function realpathP(sftp: TransferSftp, path: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    sftp.realpath(path, (err, absPath) => (err ? reject(err) : resolve(absPath)))
  })
}

/**
 * 判断远端目录是否视为"已存在的根"（无需 stat/mkdir）：
 * 空、"."、"/"、Windows 盘符根（C: / C:/）。
 * @param dir 目录路径
 * @returns true 表示根
 */
function isRemoteRoot(dir: string): boolean {
  return dir === "" || dir === "." || dir === "/" || /^[A-Za-z]:[\\/]?$/.test(dir)
}

/**
 * 远端 dirname：兼容 Windows 盘符根（C:/a.txt 的父目录是 C:/，不是 C:）。
 * @param target 远端目标路径
 * @returns 父目录
 */
function remoteDirname(target: string): string {
  if (/^[A-Za-z]:\/[^/]*$/.test(target)) return target.slice(0, 3)
  return posix.dirname(target)
}

/**
 * 上传/下载临时文件路径：与目标同目录（保证 rename 不跨文件系统），文件名带随机串避免并发冲突。
 * @param target 目标路径
 * @param ext 扩展标识（part / bak）
 * @returns 临时文件路径
 */
function tempRemotePath(target: string, ext = "part"): string {
  const dir = remoteDirname(target)
  const name = `.${posix.basename(target)}.opencode-ssh-tool-${randomUUID().slice(0, 8)}.${ext}`
  if (dir === "." || dir === "") return name
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`
}

/**
 * 本地临时文件路径（与本地目标同目录）。
 * @param target 本地目标
 * @param ext 扩展标识（part / bak）
 * @returns 临时文件本地路径
 */
function tempLocalPath(target: string, ext = "part"): string {
  const dir = dirname(target)
  const name = `.${basename(target)}.opencode-ssh-tool-${randomUUID().slice(0, 8)}.${ext}`
  return dir === "" ? name : join(dir, name)
}

/**
 * 递归创建远端目录（mkdir -p 语义；已存在且是目录则跳过；盘符根视为存在）。
 * @param deadline 传输 deadline
 * @param sftp SFTP 实例
 * @param dir 目标目录
 */
async function ensureRemoteDir(deadline: TransferDeadline, sftp: TransferSftp, dir: string): Promise<void> {
  if (isRemoteRoot(dir)) return
  try {
    const st = await remoteStat(deadline, sftp, dir)
    if (st.isDirectory()) return
    throw new TransferError("parent_missing", dir, "path exists but is not a directory")
  } catch (e) {
    if (e instanceof TransferError || !isNoSuchFile(e)) throw e
    await ensureRemoteDir(deadline, sftp, posix.dirname(dir))
    try {
      await deadline.run(voidP((cb) => sftp.mkdir(dir, cb)))
    } catch (mkdirErr) {
      // 并发/重试下可能已被别人创建：再 stat 确认是目录即可
      const st = await remoteStat(deadline, sftp, dir).catch(() => null)
      if (!st || !st.isDirectory()) throw mkdirErr
    }
  }
}

/**
 * 上传前准备远端父目录：mkdir=true 递归创建；否则要求父目录已存在且是目录。
 * @param deadline 传输 deadline
 * @param sftp SFTP 实例
 * @param parent 父目录路径（POSIX 语义）
 * @param mkdir 是否创建
 */
async function prepareRemoteParent(deadline: TransferDeadline, sftp: TransferSftp, parent: string, mkdir: boolean): Promise<void> {
  if (isRemoteRoot(parent)) return
  if (mkdir) {
    await ensureRemoteDir(deadline, sftp, parent)
    return
  }
  try {
    const st = await remoteStat(deadline, sftp, parent)
    if (!st.isDirectory()) throw new TransferError("parent_missing", parent, "path exists but is not a directory")
  } catch (e) {
    if (e instanceof TransferError) throw e
    if (isNoSuchFile(e)) throw new TransferError("parent_missing", parent)
    throw e
  }
}

/**
 * 下载前准备本地父目录：mkdir=true 递归创建；否则要求父目录已存在且是目录。
 * @param deadline 传输 deadline
 * @param parent 本地父目录
 * @param mkdir 是否创建
 */
async function prepareLocalParent(deadline: TransferDeadline, parent: string, mkdir: boolean): Promise<void> {
  if (!parent || parent === ".") return
  if (mkdir) {
    try {
      await deadline.run(mkdirLocal(parent, { recursive: true }))
    } catch (e) {
      if (e instanceof TransferError) throw e
      throw new TransferError("io", parent, e instanceof Error ? e.message : String(e))
    }
    return
  }
  try {
    const st = await deadline.run(statLocal(parent))
    if (!st.isDirectory()) throw new TransferError("parent_missing", parent, "path exists but is not a directory")
  } catch (e) {
    if (e instanceof TransferError) throw e
    if (isNoSuchFile(e)) throw new TransferError("parent_missing", parent)
    throw new TransferError("io", parent, e instanceof Error ? e.message : String(e))
  }
}

/** 尽力删除远端文件（清理临时文件用，不抛错；限时等待，避免死通道把错误路径挂死） */
async function bestEffortUnlinkRemote(sftp: TransferSftp, path: string): Promise<void> {
  try {
    await withTimeout(voidP((cb) => sftp.unlink(path, cb)), TRANSFER_CLEANUP_TIMEOUT_MS, () => undefined)
  } catch {
    /* 清理失败不覆盖原始错误 */
  }
}

/** 尽力删除本地文件（不抛错） */
async function bestEffortUnlinkLocal(path: string): Promise<void> {
  try {
    await unlinkLocal(path)
  } catch {
    /* 清理失败不覆盖原始错误 */
  }
}

/**
 * 安全触发进度回调：回调异常不得中断传输。
 * @param cb 进度回调（可空）
 * @param bytes 已传字节数
 * @param total 总字节数
 */
function reportProgress(cb: ((bytes: number, total: number) => void) | undefined, bytes: number, total: number): void {
  if (!cb) return
  try {
    cb(bytes, total)
  } catch {
    /* 进度回调只用于展示，任何异常都不得影响传输 */
  }
}

/**
 * 流式读写并计数：source → sink，超过 maxBytes 立即中止；任一错误销毁两端。
 * @param source 数据源（本地读流 / 远端读流）
 * @param sink 目标（远端写流 / 本地写流）
 * @param maxBytes 大小上限（运行时强制）
 * @param path 超限错误回显路径
 * @param totalSize 传输前 stat 得到的总字节数（进度回调用）
 * @param onProgress 每累计一块后的进度回调（可空；异常被吞掉）
 * @param onOpen sink 打开成功回调（用于判断独占创建是否真的创建了文件）
 * @returns promise（实际字节数）+ abort（销毁两端）
 */
function pipeWithLimit(
  source: Readable,
  sink: Writable,
  maxBytes: number,
  path: string,
  totalSize: number,
  onProgress: ((bytes: number, total: number) => void) | undefined,
  onOpen: () => void,
): { promise: Promise<number>; abort: () => void } {
  let bytes = 0
  let settled = false
  const destroy = (): void => {
    try { source.destroy() } catch { /* 忽略 */ }
    try { sink.destroy() } catch { /* 忽略 */ }
  }
  const promise = new Promise<number>((resolve, reject) => {
    const fail = (err: unknown): void => {
      if (settled) return
      settled = true
      destroy()
      reject(err instanceof TransferError ? err : new TransferError("io", path, err instanceof Error ? err.message : String(err)))
    }
    sink.once("open", onOpen)
    source.on("data", (chunk: Buffer | string) => {
      if (settled) return
      bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)
      reportProgress(onProgress, bytes, totalSize)
      if (bytes > maxBytes) fail(new TransferError("too_large", path, `${bytes} bytes > ${maxBytes} bytes`))
    })
    source.on("error", fail)
    sink.on("error", fail)
    // ssh2 的 SFTP WriteStream 成功结束时只 emit("close")，不 emit("finish")；
    // 本地 fs.WriteStream 通常两者都有。以先到者结算，失败已由 error 分支处理。
    const done = (): void => {
      if (settled) return
      // 短读/短写兜底：提前 close 或源提前结束时 bytes 可能少于 stat 得到的总大小。
      // 此时绝不能按 done 结算（会把半截文件当成功），统一报 io 让上层清理。
      if (totalSize > 0 && bytes !== totalSize) {
        fail(new TransferError("io", path, `incomplete transfer: ${bytes} of ${totalSize} bytes`))
        return
      }
      settled = true
      resolve(bytes)
    }
    sink.once("finish", done)
    sink.once("close", done)
    source.pipe(sink)
  })
  return { promise, abort: destroy }
}

/**
 * 上传流：本地文件 → 远端路径（flags "wx" 独占创建 / "w" 写临时文件）。
 * @param deadline 传输 deadline
 * @param sftp SFTP 实例
 * @param localPath 本地文件
 * @param remotePath 远端目标或临时文件
 * @param flags 远端打开标志（"wx" / "w"）
 * @param maxBytes 大小上限
 * @param state 打开状态（EXCL 时 opened=true 代表目标由本次创建；失败也能读到）
 * @param totalSize 总字节数（进度回调用）
 * @param onProgress 进度回调（可空）
 * @returns 实际字节数
 */
async function uploadStream(
  deadline: TransferDeadline,
  sftp: TransferSftp,
  localPath: string,
  remotePath: string,
  flags: "wx" | "w",
  maxBytes: number,
  state: { opened: boolean },
  totalSize: number,
  onProgress?: (bytes: number, total: number) => void,
): Promise<number> {
  deadline.check()
  const source = createLocalReadStream(localPath)
  const sink = sftp.createWriteStream(remotePath, { flags, mode: 0o666 })
  const pipe = pipeWithLimit(source, sink, maxBytes, localPath, totalSize, onProgress, () => { state.opened = true })
  const unregister = deadline.onAbort(pipe.abort)
  try {
    return await deadline.run(pipe.promise)
  } finally {
    unregister()
  }
}

/**
 * 下载流：远端路径 → 本地文件（flags "wx" 独占创建 / "w" 写临时文件）。
 * @param deadline 传输 deadline
 * @param sftp SFTP 实例
 * @param remotePath 远端文件
 * @param localPath 本地目标或临时文件
 * @param flags 本地打开标志（"wx" / "w"）
 * @param maxBytes 大小上限
 * @param state 打开状态（EXCL 时 opened=true 代表本地目标由本次创建；失败也能读到）
 * @param totalSize 总字节数（进度回调用）
 * @param onProgress 进度回调（可空）
 * @returns 实际字节数
 */
async function downloadStream(
  deadline: TransferDeadline,
  sftp: TransferSftp,
  remotePath: string,
  localPath: string,
  flags: "wx" | "w",
  maxBytes: number,
  state: { opened: boolean },
  totalSize: number,
  onProgress?: (bytes: number, total: number) => void,
  handle?: FileHandle,
): Promise<number> {
  deadline.check()
  const source = sftp.createReadStream(remotePath)
  const sink = handle
    ? handle.createWriteStream({ autoClose: true })
    : createLocalWriteStream(localPath, { flags, mode: 0o666 })
  const pipe = pipeWithLimit(source, sink, maxBytes, remotePath, totalSize, onProgress, () => { state.opened = true })
  const unregister = deadline.onAbort(pipe.abort)
  try {
    return await deadline.run(pipe.promise)
  } finally {
    unregister()
  }
}

/**
 * 远端尽力回滚：把备份移回目标（覆盖提交失败后恢复旧目标）。
 * 不受传输 deadline 限制（deadline 已过也要尝试），但受清理预算限制，通道不可用时快速放弃。
 * @param sftp SFTP 实例
 * @param backup 备份路径
 * @param target 目标路径
 * @param backupConfirmed 备份步骤是否已确认成功；为 true 时备份不存在也算回滚失败
 * @returns true 表示已恢复（或备份本来就不存在且未确认成功）；false 表示回滚失败
 */
async function rollbackRemote(sftp: TransferSftp, backup: string, target: string, backupConfirmed: boolean): Promise<boolean> {
  try {
    await withTimeout(voidP((cb) => sftp.rename(backup, target, cb)), TRANSFER_CLEANUP_TIMEOUT_MS, () => undefined)
    return true
  } catch (e) {
    // 未确认备份成功时，NO_SUCH_FILE 说明旧目标从未被移走，视为无需回滚；
    // 已确认备份成功却找不到备份，说明回滚失败，不能让调用方误以为原路径已恢复。
    return !backupConfirmed && isNoSuchFile(e)
  }
}

/**
 * 本地尽力回滚：把备份移回目标。直接做本地 rename，不受传输 deadline 限制。
 * @param backup 备份路径
 * @param target 目标路径
 * @param backupConfirmed 备份步骤是否已确认成功；为 true 时备份不存在也算回滚失败
 * @returns true 表示已恢复（或备份本来就不存在且未确认成功）；false 表示回滚失败
 */
async function rollbackLocal(backup: string, target: string, backupConfirmed: boolean): Promise<boolean> {
  try {
    await withTimeout(renameLocal(backup, target), TRANSFER_CLEANUP_TIMEOUT_MS, () => undefined)
    return true
  } catch (e) {
    return !backupConfirmed && isNoSuchFile(e)
  }
}

/**
 * 覆盖提交（远端）：临时文件 rename 到目标。
 * - 首次 rename 成功（同目录 rename，同一文件系统内原子）即完成；
 * - 服务端不允许覆盖已存在目标时：确认目标存在 → 先改名目标为备份 → 再改名临时文件；
 * - 已备份但新文件未就位的所有分支都尽力回滚旧目标（不依赖剩余 deadline，只用清理预算）；
 *   回滚失败时抛出明确的 io 错误并在 detail 中给出备份路径，避免静默留下空的原始路径。
 * @param deadline 传输 deadline
 * @param sftp SFTP 实例
 * @param temp 临时文件
 * @param target 目标文件
 */
async function commitRemoteOverwrite(deadline: TransferDeadline, sftp: TransferSftp, temp: string, target: string): Promise<void> {
  deadline.check()
  try {
    await deadline.run(voidP((cb) => sftp.rename(temp, target, cb)))
    return
  } catch (e) {
    if (deadline.expired) throw e
    // 失败路径探测只给清理预算，避免通道异常时挂满剩余总超时
    const existing = await remoteLstatOrNullWithin(sftp, target)
    if (!existing) throw e
    // 回退需要"移走旧目标 → 新文件就位"两步；剩余不足时不开始，避免被超时截断
    if (deadline.remaining() < TRANSFER_COMMIT_MIN_REMAINING_MS) throw e
    const backup = tempRemotePath(target, "bak")
    try {
      await deadline.run(voidP((cb) => sftp.rename(target, backup, cb)))
    } catch (eBackup) {
      // 旧目标可能已被移走：尽力回滚（通道仍可用时用清理预算完成）
      const restored = await rollbackRemote(sftp, backup, target, false)
      if (restored) throw eBackup
      throw new TransferError("io", target, `backup step failed and rollback failed; previous file may be at ${backup}`)
    }
    // 已备份：后续任何分支都不能让原路径空着——失败一律先尝试回滚
    let commitError: unknown = null
    if (deadline.expired) {
      commitError = new TransferError("timeout", undefined, "timed out before commit")
    } else {
      try {
        await deadline.run(voidP((cb) => sftp.rename(temp, target, cb)))
      } catch (e2) {
        commitError = e2
      }
    }
    if (commitError) {
      const restored = await rollbackRemote(sftp, backup, target, true)
      if (restored) throw commitError
      throw new TransferError("io", target, `commit failed and rollback failed; previous file kept at ${backup}`)
    }
    await bestEffortUnlinkRemote(sftp, backup)
  }
}

/**
 * 覆盖提交（本地）：临时文件 rename 到目标。
 * 同目录 rename 通常可直接覆盖；失败且目标原本存在时（权限/占用/平台差异），
 * 先把旧目标改名为备份 → 新文件就位 → 删备份；失败一律尽力回滚（本地 rename 不受传输 deadline 限制）。
 * @param deadline 传输 deadline
 * @param temp 临时文件
 * @param target 目标文件
 * @param targetExists 传输前目标是否已存在
 */
async function commitLocalOverwrite(deadline: TransferDeadline, temp: string, target: string, targetExists: boolean): Promise<void> {
  deadline.check()
  try {
    await deadline.run(renameLocal(temp, target))
    return
  } catch (e) {
    if (!targetExists || deadline.expired) throw e
    if (deadline.remaining() < TRANSFER_COMMIT_MIN_REMAINING_MS) throw e
    const backup = tempLocalPath(target, "bak")
    try {
      await deadline.run(renameLocal(target, backup))
    } catch (eBackup) {
      const restored = await rollbackLocal(backup, target, false)
      if (restored) throw eBackup
      throw new TransferError("io", target, `backup step failed and rollback failed; previous file may be at ${backup}`)
    }
    let commitError: unknown = null
    if (deadline.expired) {
      commitError = new TransferError("timeout", undefined, "timed out before commit")
    } else {
      try {
        await deadline.run(renameLocal(temp, target))
      } catch (e2) {
        commitError = e2
      }
    }
    if (commitError) {
      const restored = await rollbackLocal(backup, target, true)
      if (restored) throw commitError
      throw new TransferError("io", target, `commit failed and rollback failed; previous file kept at ${backup}`)
    }
    await bestEffortUnlinkLocal(backup)
  }
}

/**
 * 把未知错误归一为 TransferError（已是 TransferError 原样返回）。
 * @param err 原始错误
 * @param path 回显路径
 * @returns TransferError
 */
function normalizeError(err: unknown, path: string): TransferError {
  if (err instanceof TransferError) return err
  return new TransferError("io", path, err instanceof Error ? err.message : String(err))
}

/**
 * 上传：插件进程本机普通文件 → SSH 远端（SFTP）。
 * 默认独占创建目标（flags "wx"）；overwrite 时写同目录临时文件再 rename 提交。
 * 任一步失败清理临时/已创建的部分文件；超时中止通道且不主动发起新的 rename/commit（已发出的 rename 可能仍被执行）。
 * @param opts 上传参数
 * @returns 传输结果（路径/实际字节/耗时，不含内容）
 */
export async function uploadFile(opts: UploadOptions): Promise<TransferResult> {
  const started = Date.now()
  const localPath = expandLocalHome(opts.localPath)
  const remoteInput = opts.remotePath
  const maxBytes = opts.maxBytes ?? MAX_TRANSFER_BYTES
  const deadline = new TransferDeadline(opts.timeoutMs ?? TRANSFER_TIMEOUT_MS)
  const unregisterAbort = deadline.onAbort(() => {
    try { opts.sftp.destroy() } catch { /* 忽略 */ }
  })
  const unregisterExternal = registerExternalAbort(opts.abortSignal, deadline)
  let remoteTarget = ""
  let temp: string | null = null
  let directAttempted = false
  const directState = { opened: false }
  try {
    deadline.check()
    const localStat = await localLstatOrNull(deadline, localPath)
    if (!localStat) throw new TransferError("local_missing", localPath)
    assertRegularFile(localStat, "local", localPath)
    if (localStat.size > maxBytes) {
      throw new TransferError("too_large", localPath, `${localStat.size} bytes > ${maxBytes} bytes`)
    }
    // 拿到本地大小后先回调 (0,size)：空文件也有一次进度回调，Web 端可立即显示总大小
    reportProgress(opts.onProgress, 0, localStat.size)

    remoteTarget = await expandRemoteHome(deadline, opts.sftp, remoteInput)
    const existing = await remoteLstatOrNull(deadline, opts.sftp, remoteTarget)
    if (existing) {
      assertRegularFile(existing, "remote", remoteTarget)
      if (!opts.overwrite) throw new TransferError("exists", remoteTarget)
    }

    await prepareRemoteParent(deadline, opts.sftp, posix.dirname(remoteTarget), opts.mkdir === true)
    deadline.check()

    let bytes: number
    if (opts.overwrite === true) {
      temp = tempRemotePath(remoteTarget, "part")
      bytes = await uploadStream(deadline, opts.sftp, localPath, temp, "w", maxBytes, { opened: false }, localStat.size, opts.onProgress)
      deadline.check()
      await commitRemoteOverwrite(deadline, opts.sftp, temp, remoteTarget)
      temp = null // 已 rename 提交，无需再清理
    } else {
      directAttempted = true
      bytes = await uploadStream(deadline, opts.sftp, localPath, remoteTarget, "wx", maxBytes, directState, localStat.size, opts.onProgress)
    }

    return { localPath, remotePath: remoteTarget, bytes, duration: Date.now() - started }
  } catch (e) {
    // 失败清理/探测统一用清理预算（TRANSFER_CLEANUP_TIMEOUT_MS），不占用剩余总 deadline：
    // 通道异常/超时后远端回调可能永不返回，否则错误路径会被挂死。
    if (temp) await bestEffortUnlinkRemote(opts.sftp, temp)
    else if (directState.opened) await bestEffortUnlinkRemote(opts.sftp, remoteTarget)
    else if (directAttempted && !opts.overwrite) {
      if (deadline.expired) {
        // 超时中止通道前可能已在目标名下创建半截文件：尽力清理；
        // 通道已不可用时 3s 内放弃（文档已说明目标路径可能残留，重试会报 exists）
        await bestEffortUnlinkRemote(opts.sftp, remoteTarget)
      } else {
        // EXCL 打开失败：若目标此刻已存在（预检后被抢建/竞态）→ exists（原内容未被改动）
        const now = await remoteLstatOrNullWithin(opts.sftp, remoteTarget)
        if (now) throw new TransferError("exists", remoteTarget)
      }
    }
    throw normalizeError(e, remoteInput)
  } finally {
    unregisterExternal()
    unregisterAbort()
  }
}

/**
 * 下载：SSH 远端普通文件（SFTP）→ 插件进程本机。
 * 默认本地独占创建（fs flags "wx"）；overwrite 时写同目录临时文件再 rename 提交。
 * 任一步失败清理临时/已创建的部分文件；超时中止通道且不主动发起新的 rename/commit（已发出的 rename 可能仍被执行）。
 * @param opts 下载参数
 * @returns 传输结果（路径/实际字节/耗时，不含内容）
 */
export async function downloadFile(opts: DownloadOptions): Promise<TransferResult> {
  const started = Date.now()
  const localPath = expandLocalHome(opts.localPath)
  const remoteInput = opts.remotePath
  const maxBytes = opts.maxBytes ?? MAX_TRANSFER_BYTES
  const deadline = new TransferDeadline(opts.timeoutMs ?? TRANSFER_TIMEOUT_MS)
  const unregisterAbort = deadline.onAbort(() => {
    try { opts.sftp.destroy() } catch { /* 忽略 */ }
  })
  const unregisterExternal = registerExternalAbort(opts.abortSignal, deadline)
  let remotePath = ""
  let temp: string | null = null
  let directCreated = false
  const directState = { opened: false }
  try {
    deadline.check()
    remotePath = await expandRemoteHome(deadline, opts.sftp, remoteInput)
    const remoteInfo = await remoteLstatOrNull(deadline, opts.sftp, remotePath)
    if (!remoteInfo) throw new TransferError("remote_missing", remotePath)
    assertRegularFile(remoteInfo, "remote", remotePath)
    if (remoteInfo.size > maxBytes) {
      throw new TransferError("too_large", remotePath, `${remoteInfo.size} bytes > ${maxBytes} bytes`)
    }
    // 拿到远端大小后先回调 (0,size)：空文件也有一次进度回调
    reportProgress(opts.onProgress, 0, remoteInfo.size)

    const localStat = await localLstatOrNull(deadline, localPath)
    if (localStat) {
      assertRegularFile(localStat, "local", localPath)
      if (!opts.overwrite) throw new TransferError("exists", localPath)
    }

    await prepareLocalParent(deadline, dirname(localPath), opts.mkdir === true)
    deadline.check()

    let bytes: number
    if (opts.overwrite === true) {
      temp = tempLocalPath(localPath, "part")
      bytes = await downloadStream(deadline, opts.sftp, remotePath, temp, "w", maxBytes, { opened: false }, remoteInfo.size, opts.onProgress)
      deadline.check()
      await commitLocalOverwrite(deadline, temp, localPath, localStat !== null)
      temp = null // 已 rename 提交，无需再清理
    } else {
      const handle = await openLocalExclusive(deadline, localPath)
      directCreated = true
      try {
        bytes = await downloadStream(deadline, opts.sftp, remotePath, localPath, "wx", maxBytes, directState, remoteInfo.size, opts.onProgress, handle)
      } catch (e) {
        // downloadStream 在 deadline.check 失败时尚未接管 handle，这里兜底关闭
        await handle.close().catch(() => undefined)
        throw e
      }
    }

    return { localPath, remotePath, bytes, duration: Date.now() - started }
  } catch (e) {
    if (temp) await bestEffortUnlinkLocal(temp)
    else if (directCreated) await bestEffortUnlinkLocal(localPath)
    throw normalizeError(e, remoteInput)
  } finally {
    unregisterExternal()
    unregisterAbort()
  }
}

/**
 * 校验 upload/download 的位置参数：必须恰好两个非空路径（多给/少给都报用法）。
 * @param positionals 位置参数
 * @returns 两个路径；不合法时 null
 */
export function parseTransferPositionals(positionals: string[]): { first: string; second: string } | null {
  if (positionals.length !== 2) return null
  const [first, second] = positionals
  if (!first || !second) return null
  return { first, second }
}

/**
 * 断言会话具备文件传输能力（仅 SSH 会话）：LocalSession 等明确拒绝。
 * 用结构判定而非 instanceof，避免 transfer.ts 反向依赖 session.ts（循环导入）。
 * @param session 终端会话
 * @throws {TransferError} code=ssh_only
 */
export function assertTransferCapable(session: unknown): asserts session is TransferCapableSession {
  const s = session as Partial<TransferCapableSession> | null | undefined
  if (!s || typeof s.uploadFile !== "function" || typeof s.downloadFile !== "function") {
    throw new TransferError("ssh_only", undefined, "file transfer requires an SSH session")
  }
}
