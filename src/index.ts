// 插件入口：导出 6 个 SSH 工具 + 会话生命周期管理

import { tool, type Plugin } from "@opencode-ai/plugin"
import createLogger from "@xiaoqiong0v0/opencode-plugin-logger"
import { SWEEP_INTERVAL_MS, IDLE_TIMEOUT_MS } from "./constants.js"
import { T, getLang, tr } from "./i18n.js"
import { decide } from "./permission.js"
import { SshSession, type SessionStatus } from "./session.js"
import { buildTerminalHtml, toDataUrl } from "./utils.js"

const log = createLogger("opencode-ssh-tool", { enabled: true })
const lang = getLang()

/** 会话表：key = opencode sessionID */
export const sshSessions = new Map<string, SshSession>()

/** 空闲清扫：定期关闭超时未活动的会话 */
const sweeper = setInterval(() => {
  const now = Date.now()
  for (const [sid, s] of sshSessions) {
    const st = s.getStatus()
    if (st.connected && now - (st.lastActive ?? 0) > IDLE_TIMEOUT_MS) {
      log.info(`空闲超时，关闭会话 ${sid} @${st.host}`)
      s.close()
      sshSessions.delete(sid)
    }
  }
}, SWEEP_INTERVAL_MS)
sweeper.unref?.()

/** 进程退出兜底：关闭全部连接 */
process.on("exit", () => {
  for (const s of sshSessions.values()) s.close()
})

/** 按 sessionID 取会话 */
function getSession(sessionID: string): SshSession | undefined {
  return sshSessions.get(sessionID)
}

export const OpenCodeSshTool: Plugin = async () => {
  return {
    tool: {
      ssh_connect: tool({
        description: T.ssh_connect[lang],
        args: {
          host: tool.schema.string().describe(T.ssh_connect_args.host[lang]),
          user: tool.schema.string().describe(T.ssh_connect_args.user[lang]),
          port: tool.schema.number().optional().describe(T.ssh_connect_args.port[lang]),
        },
        async execute(args, context) {
          const { sessionID } = context
          try {
            await context.ask({
              permission: "ssh_connect",
              patterns: [`${args.user}@${args.host}:${args.port ?? 22}`],
              always: [`ssh_connect:${args.user}@${args.host}:${args.port ?? 22}`],
              metadata: { title: `SSH 连接 ${args.user}@${args.host}` },
            })
          } catch {
            return tr("rejected_connect", lang)
          }

          // 同 sessionID 已有连接 → 先关旧的
          const old = getSession(sessionID)
          if (old) {
            old.close()
            sshSessions.delete(sessionID)
          }

          const session = new SshSession(sessionID)
          const result = await session.connect(args)
          log.tool("ssh_connect", { host: args.host, user: args.user, port: args.port ?? 22 })

          if (!result.ok) {
            return { title: "SSH 连接失败", output: result.error ?? "未知错误" }
          }

          sshSessions.set(sessionID, session)
          return {
            title: `SSH 已连接 ${args.user}@${args.host}`,
            output: `连接成功：${args.user}@${args.host}:${args.port ?? 22}（session ${sessionID}）`,
            metadata: { host: args.host, user: args.user, port: args.port ?? 22 },
          }
        },
      }),

      ssh_exec: tool({
        description: T.ssh_exec[lang],
        args: {
          command: tool.schema.string().describe(T.ssh_exec_args.command[lang]),
        },
        async execute(args, context) {
          const { sessionID } = context
          const session = getSession(sessionID)
          if (!session) return tr("not_connected", lang)

          // 权限判定：先黑后白再问
          const decision = decide(args.command)
          if (decision === "deny") {
            log.tool("ssh_exec_denied", { command: args.command })
            return tr("denied_danger", lang)
          }
          if (decision === "ask") {
            try {
              await context.ask({
                permission: "ssh_exec",
                patterns: [args.command],
                always: [`ssh_exec:${args.command}`],
                metadata: { title: `SSH 执行: ${args.command.slice(0, 60)}` },
              })
            } catch {
              return tr("denied", lang)
            }
          }

          const result = await session.exec(args.command)
          session.touch()
          log.tool("ssh_exec", { command: args.command, ok: result.ok, interactive: result.interactive, running: result.running })

          const meta: Record<string, string | number | boolean | undefined> = {
            host: result.host,
            command: result.command,
            duration: result.duration,
            interactive: result.interactive,
            running: result.running,
            timeout: result.timeout,
          }
          return {
            title: `SSH 执行: ${args.command.slice(0, 60)}`,
            output: result.ok ? result.output : result.error ?? "执行失败",
            metadata: meta,
          }
        },
      }),

      ssh_read: tool({
        description: T.ssh_read[lang],
        args: {
          lines: tool.schema.number().optional().describe(T.ssh_read_args.lines[lang]),
        },
        async execute(_args, context) {
          const session = getSession(context.sessionID)
          if (!session) return tr("not_connected", lang)
          const r = await session.readBuffer()
          const out = _args.lines ? r.output.split(/\r?\n/).slice(0, _args.lines).join("\n") : r.output
          return { title: "SSH 会话输出", output: out }
        },
      }),

      ssh_status: tool({
        description: T.ssh_status[lang],
        args: {},
        async execute(_args, context) {
          const session = getSession(context.sessionID)
          if (!session) return tr("no_sessions", lang)
          const st: SessionStatus = session.getStatus()
          if (!st.connected) return "SSH 会话已断开"
          const lines = [
            `connected: ${st.connected}`,
            `busy: ${st.busy}`,
            `pending: ${st.pending} bytes`,
            `host: ${st.host}@${st.user}:${st.port}`,
            st.lastActive ? `lastActive: ${new Date(st.lastActive).toISOString()}` : null,
            st.connectedAt ? `connectedAt: ${new Date(st.connectedAt).toISOString()}` : null,
          ].filter(Boolean)
          const runningHint = st.busy
            ? "\n提示：仍有命令在执行，请等待后重试或调用 ssh_read 获取部分输出。"
            : "\n提示：无命令在执行，可安全执行新命令或调用 ssh_read 读取剩余输出。"
          return { title: "SSH 会话状态", output: lines.join("\n") + runningHint }
        },
      }),

      ssh_terminal: tool({
        description: T.ssh_terminal[lang],
        args: {},
        async execute(_args, context) {
          const session = getSession(context.sessionID)
          if (!session) return tr("no_sessions", lang)
          const st = session.getStatus()
          const transcript = session.getTranscript()
          const title = `SSH 终端记录 ${st.host ?? ""}`
          const html = buildTerminalHtml(transcript, title)
          const url = toDataUrl(html, "text/html")
          return {
            title,
            output: `终端记录已生成（${transcript.length} 字符，连接 ${st.host ?? "-"}，busy=${st.busy}）。点击附件在浏览器中滚动查看。`,
            attachments: [{ type: "file", mime: "text/html", url }],
          }
        },
      }),

      ssh_disconnect: tool({
        description: T.ssh_disconnect[lang],
        args: {},
        async execute(_args, context) {
          const session = getSession(context.sessionID)
          if (!session) return tr("no_sessions", lang)
          const host = session.getStatus().host
          session.close()
          sshSessions.delete(context.sessionID)
          return `SSH 连接已断开（${host ?? "-"}）。`
        },
      }),
    },
  }
}
