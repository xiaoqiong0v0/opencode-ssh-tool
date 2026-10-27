// 发送前语法预检（term_exec / web run-exec 共用）：
// 只解析、绝不执行；命中语法错误即拦下并返回文案，模块自身异常一律放行。
// - 本地会话：走 parse-check（本机/容器的校验器：pwsh 解析侧车 / `bash -n`、`zsh -n`）。
// - SSH 远程：走会话提供的 `precheckSyntax`（独立 exec channel：bash/zsh 跑 `-n`，
//   pwsh 启动解析侧车；不占 PTY）；两者互不复用，远程通道异常/超时一律 fail-open。
//   CMD 没有安全的 parse-only 通道，明确跳过（只查 shell 语法，不查 Python/Node 等程序代码）。
// 单独成文件是为了让 index（工具入口）与 agent（web 执行入口）共用，避免 index↔agent 循环依赖。

import { stripCommandTail } from "./base-session.js"
import { REMOTE_PRECHECK_TIMEOUT_MS } from "./constants.js"
import { validateCommand, type ParseCheckResult, type ParseIssue } from "./parse-check.js"
import log from "./log.js"
import { getToolLang, tr, type Lang } from "./i18n.js"

/** 单条拦截消息最多列出的错误条数（长命令多错误时避免刷屏） */
const SYNTAX_REJECT_MAX_ERRORS = 5

/** 拦截消息里出错片段的展示长度上限（超长截断，保留可定位性） */
const SYNTAX_ISSUE_TEXT_MAX = 60

/** 远程预检提取出错片段的长度上限（字符）：避免把超长命令整行塞进拦截文案 */
const REMOTE_SYNTAX_FRAGMENT_MAX = 200

/**
 * 适配器名 → parse-check 的 shell 标识（shell-adapter 的 `name` 与 classifyShell 兼容）。
 * 未列出的适配器（cmd 等）不校验、直接放行；bash/zsh 各自走 `bash -n`/`zsh -n`，
 * 解释器不可用时由 parse-check 内部降级放行（绝不误拦）。
 */
const CHECK_SHELL_BY_ADAPTER: Readonly<Record<string, string>> = {
  pwsh: "pwsh",
  bash: "bash",
  zsh: "zsh",
}

/** 语法校验函数签名（默认取 parse-check 的 validateCommand；第三参仅供单测注入异常实现） */
export type CommandValidator = (shell: string, text: string) => Promise<ParseCheckResult>

/** 预检所需的会话能力（SshSession / LocalSession / AgentSession 均满足） */
export interface PrecheckTarget {
  /** 探测到的 shell 适配器名；未探测到为 null */
  readonly shellName: string | null
  /** 是否本地会话（false 为 SSH 远程，走可选 precheckSyntax） */
  readonly isLocal: boolean
  /**
   * SSH 远程专用语法预检（独立 exec channel，不占 PTY）：未提供则远程直接放行。
   * 只有 SshSession 实现；本地会话不使用本方法（本地走 parse-check）。
   */
  readonly precheckSyntax?: (command: string) => Promise<ParseCheckResult>
}

/**
 * 把出错片段压成单行可读文本并加单引号（压平空白 + 超长截断）
 * @param text 解析器返回的出错片段
 * @returns 形如 `'片段'` 的展示文本
 */
function formatIssueText(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  const clipped = flat.length > SYNTAX_ISSUE_TEXT_MAX ? `${flat.slice(0, SYNTAX_ISSUE_TEXT_MAX)}…` : flat
  return `'${clipped}'`
}

/**
 * 取出错片段：优先用解析器返回的 Extent.Text；
 * 为空时（PowerShell 对 `if` 这类"只报位置、extent 为空"的错误会给空文本）
 * 回退到命令中出错行的原文，保证拦截消息始终带可定位的片段。
 * @param issue 单条解析错误
 * @param command 原始命令文本（未发送）
 * @returns 片段原文（命令行缺失时为空串）
 */
function issueFragment(issue: ParseIssue, command: string): string {
  if (issue.text.trim()) return issue.text
  return command.split(/\r?\n/)[issue.line - 1] ?? ""
}

/**
 * 把模板里的 `{key}` 占位替换为值
 * @param tpl 模板文本
 * @param vars 占位值
 * @returns 替换后的文本
 */
function fillTemplate(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`))
}

/**
 * 把解析错误列表拼成面向模型的拦截文案（含 ErrorId + 行 + 列 + 出错片段）
 * @param command 原始命令文本（供 extent 为空时回退取片段）
 * @param errors 解析错误列表（调用方保证非空）
 * @param lang 文案语言
 * @returns 拦截文案，如 `发送前语法校验失败：ErrorId=X 位置=行1列3 片段='if'`
 */
export function formatSyntaxRejection(command: string, errors: ParseIssue[], lang: Lang): string {
  const shown = errors.slice(0, SYNTAX_REJECT_MAX_ERRORS)
  const sep = lang === "zh" ? "；" : "; "
  const body = shown
    .map((e) => fillTemplate(tr("precheck_entry", lang), {
      errorId: e.errorId,
      line: e.line,
      col: e.col,
      fragment: formatIssueText(issueFragment(e, command)),
    }))
    .join(sep)
  const more = errors.length > shown.length ? `${sep}${fillTemplate(tr("precheck_more", lang), { n: errors.length })}` : ""
  return `${tr("precheck_failed", lang)}${lang === "zh" ? "：" : ": "}${body}${more}`
}

/**
 * 远程预检的出错片段：优先取命令中出错行的原文，取不到再退回解析器输出首行。
 * 结果压成单行并限制长度，避免把整条超长命令回显进拦截文案。
 * @param command 待发送的命令文本
 * @param line 解析出的错误行号（1 起；0/非法时只看 fallback）
 * @param fallback 解析器 stderr（用于取首行）
 * @returns 单行片段（可能为空串）
 */
export function pickSyntaxErrorText(command: string, line: number, fallback: string): string {
  const fromCommand = line > 0 ? (command.split(/\r?\n/)[line - 1] ?? "") : ""
  const source = fromCommand.trim() ? fromCommand : (fallback.split(/\r?\n/)[0] ?? "")
  const flat = source.replace(/\s+/g, " ").trim()
  return flat.length > REMOTE_SYNTAX_FRAGMENT_MAX ? `${flat.slice(0, REMOTE_SYNTAX_FRAGMENT_MAX)}…` : flat
}

/**
 * 发送前语法预检（只解析、绝不执行）：命中语法错误即拦下并返回文案，放行返回 null。
 * - 本地会话：parse-check（pwsh/bash/zsh；cmd 等跳过）。
 * - SSH 远程：仅当会话提供 `precheckSyntax` 时调用（SshSession 对 bash/zsh/pwsh 启用，
 *   CMD 无安全 parse-only 通道故跳过），与本地 parse-check 完全分离；未提供/抛异常/超时一律 fail-open。
 * - 校验模块异常一律放行，绝不因预检故障阻塞命令。
 * @param session 已解析的会话（需提供 shellName/isLocal，远程另需 precheckSyntax）
 * @param command 待发送的命令文本
 * @param validate 本地校验函数（默认 validateCommand；仅供单测注入异常实现）
 * @param lang 文案语言（默认取当前工具语言）
 * @param remoteTimeoutMs 远程预检等待上限（毫秒；默认 REMOTE_PRECHECK_TIMEOUT_MS，仅供单测缩短）
 * @returns null=放行；非 null=拦截文案（调用方直接返回，不写终端）
 */
export async function precheckBeforeExec(
  session: PrecheckTarget,
  command: string,
  validate: CommandValidator = validateCommand,
  lang: Lang = getToolLang(),
  remoteTimeoutMs: number = REMOTE_PRECHECK_TIMEOUT_MS,
): Promise<string | null> {
  if (!session.isLocal) return precheckRemote(session, command, lang, remoteTimeoutMs)
  const shell = CHECK_SHELL_BY_ADAPTER[session.shellName ?? ""]
  if (!shell) return null // cmd 等不支持的 shell：跳过校验
  try {
    // 校验执行器实际会发送的命令体：与 _composeEchoText 一致地剥掉尾注释/尾运算符
    const target = stripCommandTail(command, shell)
    if (!target) return null
    const result = await validate(shell, target)
    return result.ok ? null : formatSyntaxRejection(target, result.errors, lang)
  } catch (e) {
    log.error("发送前语法校验异常，放行命令", e instanceof Error ? e : String(e))
    return null // 预检故障绝不阻塞命令
  }
}

/**
 * 远程会话的发送前预检：调用会话自带的 `precheckSyntax`（独立 exec channel）。
 * 未实现、调用异常、超时、返回结构异常一律放行（fail-open），绝不误拦或阻塞主命令。
 * @param session 已解析的远程会话
 * @param command 待发送的命令文本
 * @param lang 文案语言
 * @param timeoutMs 等待上限（毫秒）
 * @returns null=放行；非 null=拦截文案
 */
async function precheckRemote(
  session: PrecheckTarget,
  command: string,
  lang: Lang,
  timeoutMs: number,
): Promise<string | null> {
  const precheckSyntax = session.precheckSyntax
  if (typeof precheckSyntax !== "function") return null
  try {
    // 与本地一致：校验实际会发送的命令体（剥掉尾注释/尾运算符，避免把合法命令误判）
    const target = stripCommandTail(command, session.shellName ?? "")
    if (!target) return null
    const result = await withTimeout(precheckSyntax.call(session, target), timeoutMs)
    if (!result || result.ok !== false) return null
    const errors = Array.isArray(result.errors) ? result.errors : []
    if (errors.length === 0) return null
    return formatSyntaxRejection(target, errors, lang)
  } catch (e) {
    log.error("远程发送前语法校验异常，放行命令", e instanceof Error ? e : String(e))
    return null // 预检故障绝不阻塞命令
  }
}

/**
 * 给远程预检加超时：到点返回 null（调用方按 fail-open 处理）。
 * 原 Promise 后续的 rejection 也在此处消费，避免未捕获拒绝。
 * @param task 远程预检 Promise
 * @param timeoutMs 等待上限（毫秒，最小 1）
 * @returns 预检结果；超时为 null
 */
function withTimeout(task: Promise<ParseCheckResult>, timeoutMs: number): Promise<ParseCheckResult | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: ParseCheckResult | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), Math.max(1, timeoutMs))
    task.then((value) => finish(value), () => finish(null))
  })
}
