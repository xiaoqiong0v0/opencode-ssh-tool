// SshSession：ssh2 长驻连接 + PTY shell 管理，
// 完成标记法：每条命令后追加一条标记命令，完成后输出 <SSH_DONE:nonce:seq:退出码>（不依赖 PROMPT_COMMAND/PS1 钩子）

import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from "ssh2"
import log, { isDebugEnabled, ssh2Trace } from "./log.js"
import {
  INJECT_TIMEOUT_MS,
  PTY_COLS,
  PTY_ROWS,
  READY_TIMEOUT_MS,
  REMOTE_PRECHECK_COMMAND_MAX,
  REMOTE_PRECHECK_OUTPUT_MAX,
  REMOTE_PRECHECK_TIMEOUT_MS,
  SSH_KEEPALIVE_COUNT_MAX,
  SSH_KEEPALIVE_INTERVAL_MS,
  TRANSFER_JOB_SETTLE_TIMEOUT_MS,
  TRANSFER_TIMEOUT_MS,
} from "./constants.js"
import { tr } from "./i18n.js"
import { resolveAuth, resolvePassword, type AuthInfo } from "./ssh-auth.js"
import { assertTransferCapable, downloadFile, uploadFile, TransferError, type DownloadOptions, type TransferResult, type UploadOptions } from "./transfer.js"
import type { ExecResult } from "./base-session.js"
import { BaseSession } from "./base-session.js"
import {
  encodePwshSidecarPayload,
  looksLikePosixSyntaxError,
  parsePosixSyntaxLine,
  parsePwshSidecarResponse,
  PS_SIDECAR_ENCODED_COMMAND,
  type ParseCheckResult,
  type ParseIssue,
} from "./parse-check.js"
import { pickSyntaxErrorText } from "./precheck.js"

/** 远程预检放行结果（共享单例） */
const PRECHECK_PASS: ParseCheckResult = { ok: true }

/** 远程 pwsh 侧车候选解释器（按序尝试；任一不可用/超时即 fail-open） */
const REMOTE_PWSH_CANDIDATES: readonly string[] = ["pwsh", "powershell", "powershell.exe"]

/** 侧车启动参数（脚本经 UTF-16LE base64 传入，纯 ASCII，规避远端代码页/引号问题） */
const PS_SIDECAR_ARGV = `-NoProfile -NonInteractive -NoLogo -EncodedCommand ${PS_SIDECAR_ENCODED_COMMAND}`

/** 侧车协议响应行前缀 */
const PWSH_RESPONSE_PREFIX = "ERRCOUNT="
const PWSH_ERROR_PREFIX = "ERROR="

/** 远程 pwsh 预检单次候选的结果 */
type PwshCandidateOutcome =
  | { kind: "result"; errors: ParseIssue[] }
  | { kind: "unavailable" }
  | { kind: "error" }
  | { kind: "timeout" }

/**
 * 从侧车 stdout 取出协议响应行（容忍 CRLF、UTF-8 BOM 与前置 READY 行）。
 * @param stdout 侧车标准输出
 * @returns `ERRCOUNT=...` / `ERROR=...` 行；无响应返回 null
 */
function findPwshResponseLine(stdout: string): string | null {
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.replace(/^\uFEFF/, "")
    if (line.startsWith(PWSH_RESPONSE_PREFIX) || line.startsWith(PWSH_ERROR_PREFIX)) return line
  }
  return null
}

/** 远端"解释器不存在/无法启动"的典型文案（仅在拿不到协议响应时用于决定是否换候选） */
const PWSH_UNAVAILABLE_RE = /command not found|not found|not recognized|不是内部或外部命令|无法将.*识别|未找到命令|找不到命令/i

/**
 * 追加输出并保留尾部上限，避免异常输出撑爆内存。
 * @param current 已收集文本
 * @param chunk 新到片段
 * @returns 截尾后的文本（上限 REMOTE_PRECHECK_OUTPUT_MAX）
 */
function appendBounded(current: string, chunk: string): string {
  const next = current + chunk
  return next.length > REMOTE_PRECHECK_OUTPUT_MAX ? next.slice(-REMOTE_PRECHECK_OUTPUT_MAX) : next
}

/**
 * 候选解释器是否明显"没跑起来"（不存在/启动失败）。
 * 只在没有协议响应时判定：非语法失败必须放行，绝不误拦。
 * @param exitCode 远端退出码（null=未收到）
 * @param stderr 远端标准错误输出
 * @returns 可换下一候选时为 true
 */
function isPwshCandidateUnavailable(exitCode: number | null, stderr: string): boolean {
  if (exitCode === null) return true
  if (exitCode === 0) return false
  return exitCode === 127 || exitCode === 9009 || PWSH_UNAVAILABLE_RE.test(stderr)
}

export interface SessionStatus {
  connected: boolean
  busy: boolean
  pending: number
  name?: string
  host?: string
  user?: string
  port?: number
  lastActive?: number
  connectedAt?: number
}

export interface ConnectResult {
  ok: boolean
  host?: string
  user?: string
  port?: number
  error?: string
}

export class SshSession extends BaseSession {
  private _client: Client | null = null
  private _stream: import("ssh2").ClientChannel | null = null
  private _host = ""
  private _user = ""
  private _port = 22
  /**
   * 文件传输串行链：同一 SshSession 的 upload/download 依次执行，避免同名目标并发竞争。
   * 只串行传输，不影响 PTY 命令执行（SFTP 走独立 channel，不占用 busy/PTY）。
   */
  private _transferChain: Promise<unknown> = Promise.resolve()

  protected get _extraResult(): Partial<ExecResult> { return { host: this._host } }

  protected _ready(): boolean {
    return this._connected && this._stream !== null && this._adapter !== null
  }

  protected _write(data: string): void {
    this._stream!.write(data)
  }

  protected _closeTransport(): void {
    if (this._stream) { try { this._stream.end() } catch { /* ignore */ } }
    if (this._client) { try { this._client.end() } catch { /* ignore */ } }
    log.hook("ssh_disconnect", `关闭会话 ${this._host} (session ${this.sessionID}, term ${this.name})`)
  }

  async connect(opts: { host: string; user: string; port?: number; password?: string }): Promise<ConnectResult> {
    const port = opts.port ?? 22
    let auth: AuthInfo
    if (opts.password) {
      const pw = resolvePassword(opts.password)
      auth = pw ? { password: pw } : resolveAuth(opts.host)
    } else {
      auth = resolveAuth(opts.host)
    }
    const config: ConnectConfig = {
      host: opts.host,
      port,
      username: opts.user,
      readyTimeout: READY_TIMEOUT_MS,
      // 协议级保活（连接层带外，`keepalive@openssh.com` 全局请求，不写入 channel/PTY）：
      // 空闲时定期发 keepalive，避免被路径上的 NAT/防火墙/远端 sshd 的空闲超时掐断长驻连接；
      // 连续 SSH_KEEPALIVE_COUNT_MAX 次无响应则由 ssh2 判定连接死亡（error.level="client-timeout"）。
      keepaliveInterval: SSH_KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: SSH_KEEPALIVE_COUNT_MAX,
      // ssh2 协议 trace 属 debug 级；仅在真正会输出时才注册回调，避免关闭时 ssh2 每次仍做无谓的消息拼装。
      // ssh2Trace 内部再丢弃随输出量增长的 CHANNEL_DATA 等行，只记有界的握手/认证事件。
      ...(isDebugEnabled() ? { debug: (msg: string) => ssh2Trace(this._logTag, msg) } : {}),
      ...auth,
    }

    const client = new Client()
    let settled = false

    return new Promise<ConnectResult>((resolve) => {
      const fail = (msg: string) => {
        if (settled) return
        settled = true
        log.error(`连接失败 ${opts.host} (session ${this.sessionID}, term ${this.name})`, msg)
        resolve({ ok: false, host: opts.host, user: opts.user, port, error: msg })
      }

      // 常驻错误监听：ssh2 可能多次发 error（断线/通道异常），once 首次触发后失效会变 unhandled
      client.on("error", (err: Error) => {
        if (!settled) {
          fail(err.message)
          return
        }
        // 保活判死（ssh2 在连续 keepalive 无响应后置 level="client-timeout"）与普通断线的日志可区分
        const level = (err as Error & { level?: string }).level
        if (level === "client-timeout") {
          log.error(`SSH 保活超时，连接判定死亡 ${opts.host} (session ${this.sessionID}, term ${this.name})`, err)
        } else {
          log.error(`SSH 会话错误 ${opts.host} (session ${this.sessionID}, term ${this.name})`, err)
        }
        this._connected = false
        this._setBusy(false, "SSH 会话错误")
        this._clearRunningContext()
        if (this._watchTimer) {
          clearInterval(this._watchTimer)
          this._watchTimer = null
        }
      })

      client.once("ready", () => {
        client.shell(
          { rows: PTY_ROWS, cols: PTY_COLS, term: "xterm-256color" },
          (err: Error | undefined, stream) => {
            if (err || !stream) {
              client.end()
              fail(err?.message ?? "shell open failed")
              return
            }
            settled = true
            this._client = client
            this._stream = stream
            this._connected = true
            this._host = opts.host
            this._user = opts.user
            this._port = port
            this._connectedAt = Date.now()
            this._lastActive = Date.now()

            stream.on("data", (chunk: Buffer) => { this._appendBuffer(chunk.toString()) })
            stream.on("close", () => { this._connected = false; this._setBusy(false, "PTY stream 关闭") })
            stream.on("error", (e: Error) => { log.error(`PTY stream 错误 (session ${this.sessionID}, term ${this.name})`, e); this._connected = false })

            ;(async () => {
              await new Promise((r) => setTimeout(r, 400))
              this._buffer = ""
              this._cursor = 0
              this._runningStartPos = null
              log.info(`连接成功 ${opts.user}@${opts.host}:${port} (session ${this.sessionID}, term ${this.name})`)

              if (this._history.totalPairs() > 0) this._history.clear()

              const deadline = Date.now() + INJECT_TIMEOUT_MS
              const adapter = await this._probeShell(deadline)
              if (!adapter) {
                log.error(`Shell 探测超时，终止连接 ${opts.user}@${opts.host} (session ${this.sessionID}, term ${this.name})`)
                this.close()
                resolve({ ok: false, host: opts.user, user: opts.user, port, error: tr("shell_probe_timeout", this._lang) })
                return
              }
              this._adapter = adapter
              log.info(`Shell 探测结果: ${this._adapter.name} (session ${this.sessionID}, term ${this.name})`)

              this._buffer = ""
              this._cursor = 0
              // 初始化完成：发基线标记（seq=0），让首条命令也有"前驱"可裁剪，免疫控制台屏幕重放
              this._sendBaselineMarker()
              resolve({ ok: true, host: opts.user, user: opts.user, port })
            })()
          },
        )
      })

      client.connect(config)
    })
  }

  /**
   * 上传本机文件到远端（SFTP，不占用 PTY/busy）。
   * 同一会话串行执行；每次操作打开独立 SFTP subsystem，结束即关闭。
   * @param opts 上传参数（本地/远端路径、overwrite、mkdir、超时、大小上限）
   * @returns 传输结果（路径/实际字节/耗时，不含内容）
   */
  async uploadFile(opts: Omit<UploadOptions, "sftp">): Promise<TransferResult> {
    assertTransferCapable(this)
    const timeoutMs = opts.timeoutMs ?? TRANSFER_TIMEOUT_MS
    return this._enqueueTransfer(() =>
      this._withSftp(timeoutMs, (sftp, remainingMs, abortSignal) =>
        uploadFile({ ...opts, sftp, timeoutMs: remainingMs, abortSignal }),
      ),
    )
  }

  /**
   * 下载远端文件到本机（SFTP，不占用 PTY/busy）。
   * 同一会话串行执行；每次操作打开独立 SFTP subsystem，结束即关闭。
   * @param opts 下载参数（远端/本地路径、overwrite、mkdir、超时、大小上限）
   * @returns 传输结果（路径/实际字节/耗时，不含内容）
   */
  async downloadFile(opts: Omit<DownloadOptions, "sftp">): Promise<TransferResult> {
    assertTransferCapable(this)
    const timeoutMs = opts.timeoutMs ?? TRANSFER_TIMEOUT_MS
    return this._enqueueTransfer(() =>
      this._withSftp(timeoutMs, (sftp, remainingMs, abortSignal) =>
        downloadFile({ ...opts, sftp, timeoutMs: remainingMs, abortSignal }),
      ),
    )
  }

  /**
   * SSH 远程发送前语法预检（bash/zsh/pwsh）：独立 exec channel，只解析不执行。
   * - bash/zsh：跑 `<shell> -n`，命令经 stdin 写入；
   * - pwsh：启动 PowerShell 解析侧车（与本地 parse-check 同一脚本/协议），命令以 base64 写入 stdin；
   * - 不占 PTY、不写 history、不翻转 busy、不修改 `_connected`；
   * - 其他 shell（sh/dash/cmd/未知）或未连接时直接放行；cmd 无安全 parse-only 通道，明确跳过；
   * - 通道异常、超时、拿不到响应、非语法失败一律 `{ok:true}`（绝不误拦）。
   * @param command 待校验的命令文本（调用方已剥掉尾注释/尾运算符）
   * @returns 通过或无法判定为 `{ok:true}`；确认语法错误为 `{ok:false,errors}`（含行号/片段）
   */
  async precheckSyntax(command: string): Promise<ParseCheckResult> {
    const shell = this._adapter?.name
    if (shell !== "bash" && shell !== "zsh" && shell !== "pwsh") return PRECHECK_PASS
    if (!command || !this._connected || this._client === null) return PRECHECK_PASS
    if (shell === "pwsh") return this._execPwshSyntaxCheck(this._client, command)
    return this._execSyntaxCheck(this._client, shell, command)
  }

  /**
   * 串行化文件传输：前一个任务成功或失败后都继续执行下一个（失败不阻塞队列）。
   * @param job 传输任务
   * @returns 任务结果
   */
  private _enqueueTransfer<T>(job: () => Promise<T>): Promise<T> {
    const run = this._transferChain.then(job, job)
    this._transferChain = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * 打开 SFTP subsystem 执行任务，结束后始终关闭该 SFTP 通道。
   * - 开通道也受总 deadline 约束；超时/迟到通道一律 destroy；
   * - 通道 error 常驻监听：ssh2 在 ready 后已移除其内部 onError，
   *   无监听会让协议异常变成未捕获 error；这里只记日志并中止本次传输，不改 PTY/连接状态；
   * - **串行契约**：通道 error/超时后不立即结算，而是先中止 job（AbortSignal）并等它真正 settle
   *   再 finish，避免下一个传输与孤儿 job 并行；job 自身 deadline + 清理预算应有界，
   *   超过 TRANSFER_JOB_SETTLE_TIMEOUT_MS（12s）仍未结束则强制结算（此时通道已中止，job 无法再提交）；
   * - 连接已断开/SFTP 不可用时返回 sftp_unavailable。
   * @param timeoutMs 本次传输总超时（含开通道）
   * @param job 使用 SFTP 的任务（remainingMs 为开通道后的剩余时间，abortSignal 用于通道级中止）
   * @returns 任务结果
   */
  private _withSftp<T>(
    timeoutMs: number,
    job: (sftp: SFTPWrapper, remainingMs: number, abortSignal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const client = this._client
    if (!this._connected || !client) {
      return Promise.reject(new TransferError("sftp_unavailable", undefined, "SSH session is not connected"))
    }
    const deadlineAt = Date.now() + Math.max(1, timeoutMs)
    this._lastActive = Date.now()
    return new Promise<T>((resolve, reject) => {
      let settled = false
      let jobStarted = false
      let jobSettled = false
      let channel: SFTPWrapper | null = null
      let timer: ReturnType<typeof setTimeout> | null = null
      let settleTimer: ReturnType<typeof setTimeout> | null = null
      let pendingError: Error | null = null
      const controller = new AbortController()
      const clearTimers = (): void => {
        if (timer) { clearTimeout(timer); timer = null }
        if (settleTimer) { clearTimeout(settleTimer); settleTimer = null }
      }
      const finish = (err: Error | null, value?: T): void => {
        if (settled) return
        settled = true
        clearTimers()
        this._lastActive = Date.now()
        if (err) reject(err)
        else resolve(value as T)
      }
      /** 通道级失败：job 已在跑时等它 settle（有兜底上限），保证同一会话的传输不并行 */
      const failAfterJob = (err: Error): void => {
        if (settled) return
        pendingError = err
        if (!jobStarted || jobSettled) {
          finish(err)
          return
        }
        if (!settleTimer) {
          settleTimer = setTimeout(() => finish(pendingError ?? err), TRANSFER_JOB_SETTLE_TIMEOUT_MS)
        }
      }
      /** 中止传输 job（signal → transfer deadline 立即拒绝）并销毁通道，然后按串行契约结算 */
      const abortJob = (err: TransferError): void => {
        try {
          controller.abort(err)
        } catch {
          /* 忽略 */
        }
        try {
          channel?.destroy()
        } catch {
          /* 通道可能尚未就绪/已关闭 */
        }
        failAfterJob(err)
      }
      timer = setTimeout(() => {
        abortJob(new TransferError("timeout", undefined, `SFTP channel timeout after ${timeoutMs}ms`))
      }, Math.max(1, deadlineAt - Date.now()))
      try {
        client.sftp((err, sftp) => {
          if (settled) {
            // 通道在超时/失败之后才就绪：直接销毁，避免泄漏
            try {
              sftp?.destroy()
            } catch {
              /* 忽略 */
            }
            return
          }
          if (err || !sftp) {
            finish(new TransferError("sftp_unavailable", undefined, err?.message ?? "SFTP subsystem unavailable"))
            return
          }
          channel = sftp
          // 常驻 error 监听：不改变 PTY/连接状态，只中止本次 transfer（等 job settle 后再结算）
          sftp.on("error", (e: Error) => {
            log.error(`SFTP 通道错误 (session ${this.sessionID}, term ${this.name})`, e)
            abortJob(new TransferError("io", undefined, `SFTP channel error: ${e.message}`))
          })
          const remaining = deadlineAt - Date.now()
          if (remaining <= 0) {
            abortJob(new TransferError("timeout", undefined, `SFTP channel timeout after ${timeoutMs}ms`))
            return
          }
          jobStarted = true
          let work: Promise<T>
          try {
            work = job(sftp, remaining, controller.signal)
          } catch (e) {
            jobSettled = true
            try {
              sftp.destroy()
            } catch {
              /* 忽略 */
            }
            failAfterJob(e instanceof Error ? e : new Error(String(e)))
            return
          }
          work.then(
            (value) => {
              jobSettled = true
              try {
                sftp.end()
              } catch {
                /* 忽略 */
              }
              // 已发生通道级失败时以失败为准，不能把迟到成功当成功返回
              if (pendingError) finish(pendingError)
              else finish(null, value)
            },
            (e) => {
              jobSettled = true
              try {
                sftp.end()
              } catch {
                /* 忽略 */
              }
              finish(e instanceof Error ? e : new Error(String(e)))
            },
          )
        })
      } catch (e) {
        failAfterJob(new TransferError("sftp_unavailable", undefined, e instanceof Error ? e.message : String(e)))
      }
    })
  }

  /**
   * 用独立 SSH exec channel 跑 `<shell> -n`：命令文本经 stdin 写入（末尾补换行）后 EOF。
   * 只解析不执行；通道结束/错误/超时都只结算本次预检，不触碰 PTY、busy、history 或连接状态。
   * @param client 当前 SSH 客户端（调用方已确认非 null 且已连接）
   * @param shell bash 或 zsh
   * @param command 待校验命令文本
   * @returns 确认语法错误 `{ok:false,errors}`；其余情况一律 `{ok:true}`（fail-open）
   */
  private _execSyntaxCheck(client: Client, shell: "bash" | "zsh", command: string): Promise<ParseCheckResult> {
    return new Promise<ParseCheckResult>((resolve) => {
      let settled = false
      /** 远端退出码；未收到 exit 事件时为 null（按"无法判定"放行） */
      let exitCode: number | null = null
      let stderr = ""
      let stdout = ""
      let stream: ClientChannel | null = null
      let timer: ReturnType<typeof setTimeout> | null = null

      /** 单次结算：清定时器；abort=true 时销毁预检通道（超时/错误路径） */
      const settle = (result: ParseCheckResult, abort = false): void => {
        if (settled) return
        settled = true
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
        if (abort && stream !== null) {
          try {
            stream.destroy()
          } catch {
            /* 通道可能已关闭 */
          }
        }
        resolve(result)
      }

      /** 通道关闭：只有"非 0 退出码 + stderr 确实像语法错误"才拦截，其余放行 */
      const finish = (): void => {
        if (settled) return
        if (exitCode === null || exitCode === 0 || !looksLikePosixSyntaxError(stderr)) {
          settle(PRECHECK_PASS)
          return
        }
        const line = parsePosixSyntaxLine(stderr)
        const detail = stderr.trim() ? stderr : stdout
        settle({
          ok: false,
          errors: [{ errorId: `${shell}-syntax`, line, col: 1, text: pickSyntaxErrorText(command, line, detail) }],
        })
      }

      timer = setTimeout(() => {
        log.info(`远程语法预检超时，放行命令 (session ${this.sessionID}, term ${this.name})`)
        settle(PRECHECK_PASS, true)
      }, REMOTE_PRECHECK_TIMEOUT_MS)

      try {
        client.exec(`${shell} -n`, { pty: false }, (err, channel) => {
          // 超时/错误之后才建好的通道：直接销毁，避免泄漏
          if (settled) {
            try {
              channel?.destroy()
            } catch {
              /* 已关闭 */
            }
            return
          }
          if (err || !channel) {
            log.info(`远程语法预检通道不可用，放行命令 (session ${this.sessionID}, term ${this.name})`)
            settle(PRECHECK_PASS)
            return
          }
          stream = channel
          channel.on("error", (e: Error) => {
            if (settled) return
            log.info(`远程语法预检通道错误，放行命令 (session ${this.sessionID}, term ${this.name}): ${e.message}`)
            settle(PRECHECK_PASS, true)
          })
          channel.stderr.on("error", () => settle(PRECHECK_PASS, true))
          channel.stderr.setEncoding("utf8")
          channel.stderr.on("data", (chunk: string) => { stderr = appendBounded(stderr, chunk) })
          channel.setEncoding("utf8")
          channel.on("data", (chunk: string) => { stdout = appendBounded(stdout, chunk) })
          // 只认 exit 的退出码；close 用于确保 stdout/stderr 已消费完毕再结算
          channel.on("exit", (code: number | null) => {
            exitCode = typeof code === "number" ? code : null
          })
          channel.on("close", finish)
          try {
            channel.end(command.endsWith("\n") ? command : `${command}\n`)
          } catch {
            settle(PRECHECK_PASS, true)
          }
        })
      } catch (e) {
        log.error(`远程发送前语法预检异常，放行命令 (session ${this.sessionID}, term ${this.name})`, e instanceof Error ? e : String(e))
        settle(PRECHECK_PASS)
      }
    })
  }

  /**
   * 用独立 SSH exec channel 启动 PowerShell 解析侧车（只解析不执行）：
   * 复用本地 parse-check 的侧车脚本/响应协议，命令以 base64(UTF-8) 写入 stdin，
   * 随后写 `!QUIT` 让侧车自行退出；只读 stdout 的 `ERRCOUNT=` 行，不触碰 PTY/连接状态。
   * 命令超长或编码失败直接放行（fail-open）。
   * @param client 当前 SSH 客户端（调用方已确认非 null 且已连接）
   * @param command 待校验命令文本
   * @returns 确认语法错误 `{ok:false,errors}`；其余情况一律 `{ok:true}`
   */
  private _execPwshSyntaxCheck(client: Client, command: string): Promise<ParseCheckResult> {
    if (command.length > REMOTE_PRECHECK_COMMAND_MAX) {
      log.info(`远程 pwsh 语法预检：命令超长，放行命令 (session ${this.sessionID}, term ${this.name})`)
      return Promise.resolve(PRECHECK_PASS)
    }
    let payload: string
    try {
      payload = encodePwshSidecarPayload(command)
    } catch (e) {
      log.error(`远程 pwsh 语法预检编码失败，放行命令 (session ${this.sessionID}, term ${this.name})`, e instanceof Error ? e : String(e))
      return Promise.resolve(PRECHECK_PASS)
    }
    return this._runPwshCandidates(client, payload)
  }

  /**
   * 按候选顺序（pwsh → powershell → powershell.exe）启动侧车，共享总超时预算。
   * 只有"候选不可用"（找不到解释器/启动失败）才换下一个；拿到协议结果或通道异常/超时即结算，
   * 除确认语法错误外一律返回 `{ok:true}`。
   * @param client 当前 SSH 客户端
   * @param payload base64(UTF-8 命令文本)
   * @returns 预检结果（fail-open）
   */
  private async _runPwshCandidates(client: Client, payload: string): Promise<ParseCheckResult> {
    const deadlineAt = Date.now() + REMOTE_PRECHECK_TIMEOUT_MS
    for (const bin of REMOTE_PWSH_CANDIDATES) {
      const remaining = deadlineAt - Date.now()
      if (remaining <= 0) break
      const outcome = await this._runPwshCandidate(client, bin, payload, remaining)
      if (outcome.kind === "result") {
        return outcome.errors.length === 0 ? PRECHECK_PASS : { ok: false, errors: outcome.errors }
      }
      if (outcome.kind === "unavailable") {
        log.info(`远程 pwsh 语法预检候选不可用（${bin}），尝试下一候选 (session ${this.sessionID}, term ${this.name})`)
        continue
      }
      // 侧车内部异常 / 超时：放行，不再重试（超时已耗尽预算）
      log.info(`远程 pwsh 语法预检未获结果（${bin}:${outcome.kind}），放行命令 (session ${this.sessionID}, term ${this.name})`)
      return PRECHECK_PASS
    }
    log.info(`远程 pwsh 语法预检无可用候选，放行命令 (session ${this.sessionID}, term ${this.name})`)
    return PRECHECK_PASS
  }

  /**
   * 单个候选解释器的一次预检：打开独立 exec channel、写入请求与 `!QUIT`、收集 stdout/stderr。
   * 结算时清定时器/销毁通道；通道错误与"命令不存在"都只影响本次预检。
   * @param client 当前 SSH 客户端
   * @param bin 候选解释器名（pwsh / powershell / powershell.exe）
   * @param payload base64(UTF-8 命令文本)
   * @param timeoutMs 本次候选的剩余预算（毫秒）
   * @returns 候选结果（result/unavailable/error/timeout）
   */
  private _runPwshCandidate(
    client: Client,
    bin: string,
    payload: string,
    timeoutMs: number,
  ): Promise<PwshCandidateOutcome> {
    return new Promise<PwshCandidateOutcome>((resolve) => {
      let settled = false
      /** 远端退出码；未收到 exit 事件时为 null（按"候选不可用"处理，交给下一个候选） */
      let exitCode: number | null = null
      let stdout = ""
      let stderr = ""
      let stream: ClientChannel | null = null
      let timer: ReturnType<typeof setTimeout> | null = null

      /** 单次结算：清定时器；destroy=true 时销毁预检通道（超时/错误路径） */
      const settle = (outcome: PwshCandidateOutcome, destroy = false): void => {
        if (settled) return
        settled = true
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
        if (destroy && stream !== null) {
          try {
            stream.destroy()
          } catch {
            /* 通道可能已关闭 */
          }
        }
        stream = null
        resolve(outcome)
      }

      /** 通道关闭：先找协议响应行；无响应时按退出码/错误文案判断是否换下一候选 */
      const finishFromOutput = (): void => {
        if (settled) return
        const line = findPwshResponseLine(stdout)
        if (line !== null) {
          if (line.startsWith(PWSH_ERROR_PREFIX)) {
            settle({ kind: "error" })
            return
          }
          const errors = parsePwshSidecarResponse(line)
          settle(errors === null ? { kind: "error" } : { kind: "result", errors })
          return
        }
        settle(isPwshCandidateUnavailable(exitCode, stderr) ? { kind: "unavailable" } : { kind: "error" })
      }

      timer = setTimeout(() => settle({ kind: "timeout" }, true), Math.max(1, timeoutMs))

      try {
        client.exec(`${bin} ${PS_SIDECAR_ARGV}`, { pty: false }, (err, channel) => {
          // 超时/错误之后才建好的通道：直接销毁，避免泄漏
          if (settled) {
            try {
              channel?.destroy()
            } catch {
              /* 已关闭 */
            }
            return
          }
          if (err || !channel) {
            settle({ kind: "unavailable" })
            return
          }
          stream = channel
          // 通道级错误只影响本候选（可能只是"命令不存在"导致写失败）：交给下一个候选
          channel.on("error", () => settle({ kind: "unavailable" }, true))
          channel.stderr.on("error", () => settle({ kind: "unavailable" }, true))
          channel.stderr.setEncoding("utf8")
          channel.stderr.on("data", (chunk: string) => { stderr = appendBounded(stderr, chunk) })
          channel.setEncoding("utf8")
          channel.on("data", (chunk: string) => { stdout = appendBounded(stdout, chunk) })
          channel.on("exit", (code: number | null) => {
            exitCode = typeof code === "number" ? code : null
          })
          channel.on("close", finishFromOutput)
          try {
            // 一行请求 + !QUIT：侧车解析后输出 ERRCOUNT 行并自行退出
            channel.end(`${payload}\n!QUIT\n`)
          } catch {
            settle({ kind: "unavailable" }, true)
          }
        })
      } catch (e) {
        log.error(`远程 pwsh 语法预检通道异常，放行命令 (session ${this.sessionID}, term ${this.name})`, e instanceof Error ? e : String(e))
        settle({ kind: "unavailable" })
      }
    })
  }

  getStatus(): SessionStatus {
    return {
      connected: this._connected,
      busy: this._connected && this._remoteBusy,
      pending: this._buffer.length,
      name: this.name,
      host: this._host,
      user: this._user,
      port: this._port,
      lastActive: this._lastActive,
      connectedAt: this._connectedAt,
    }
  }
}

/** runSshTransfer 参数 */
export interface SshTransferRunParams<T> {
  /** 解析后的终端会话（index 层传入，必须为 SshSession） */
  session: unknown
  /** 权限审批（index 层传入 ctx.ask 调用；在传输前执行） */
  ask: () => Promise<void>
  /** 审批通过后的实际传输 */
  run: (session: SshSession) => Promise<T>
}

/**
 * index 层文件传输统一入口：先做 SSH 会话判定，再审批，最后才执行传输。
 * - 非 SshSession（LocalSession / docker / wsl）→ ssh_only，不审批、不打开 SFTP；
 * - 审批拒绝 → denied，同样不开始传输；
 * - 顺序固定：instanceof → ask → run，避免"先传后审"或对本地会话假装可传。
 * @param params 会话、审批回调、传输回调
 * @returns 传输结果
 * @throws {TransferError} code=ssh_only / denied 或传输本身的错误
 */
export async function runSshTransfer<T>(params: SshTransferRunParams<T>): Promise<T> {
  if (!(params.session instanceof SshSession)) {
    throw new TransferError("ssh_only", undefined, "file transfer requires an SSH session")
  }
  try {
    await params.ask()
  } catch {
    throw new TransferError("denied", undefined, "transfer denied by user")
  }
  return params.run(params.session)
}
