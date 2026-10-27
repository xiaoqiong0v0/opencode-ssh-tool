// SshSession.precheckSyntax 单测：用 fake SSH client 验证独立 exec channel 的放行/拦截行为，
// 不依赖真实网络或 Docker。
import test from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { SshSession } from "../dist/session.js"
import { SessionHistory } from "../dist/history.js"

/** 假 SSH 通道：够 precheckSyntax 用的最小事件/流接口 */
class FakeChannel extends EventEmitter {
  constructor(onEnd) {
    super()
    this.stderr = new EventEmitter()
    this.stderr.setEncoding = () => {}
    this._onEnd = onEnd
    this.destroyed = false
  }

  setEncoding() {}

  end(data) {
    this._onEnd?.(data)
  }

  destroy() {
    this.destroyed = true
  }
}

/** 建一个带 fake 适配器/客户端的最小 SshSession（预检只需 _adapter/_client/_connected） */
function makeSession(shell) {
  const root = mkdtempSync(join(tmpdir(), "ssh-precheck-"))
  const session = new SshSession("sess", new SessionHistory(root, "sess", 10), "default", "en")
  session._adapter = { name: shell }
  session._connected = true
  return { session, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test("bash 退出码 0 → 放行；命令经 stdin 写入并补换行，pty:false", async (t) => {
  const { session, cleanup } = makeSession("bash")
  t.after(cleanup)
  let wrote = null
  session._client = {
    exec(command, options, cb) {
      assert.equal(command, "bash -n")
      assert.deepEqual(options, { pty: false })
      const ch = new FakeChannel((data) => {
        wrote = data
        ch.emit("exit", 0)
        ch.emit("close")
      })
      cb(undefined, ch)
    },
  }
  assert.deepEqual(await session.precheckSyntax("echo hi"), { ok: true })
  assert.equal(wrote, "echo hi\n")
})

test("bash 退出码 2 + 语法错误 → 拦截（bash-syntax，行号/片段来自命令）", async (t) => {
  const { session, cleanup } = makeSession("bash")
  t.after(cleanup)
  session._client = {
    exec(_command, _options, cb) {
      const ch = new FakeChannel(() => {
        ch.stderr.emit("data", "bash: line 2: syntax error near unexpected token `then'\n")
        ch.emit("exit", 2)
        ch.emit("close")
      })
      cb(undefined, ch)
    },
  }
  const result = await session.precheckSyntax("echo ok\nif then")
  assert.equal(result.ok, false)
  assert.equal(result.errors[0].errorId, "bash-syntax")
  assert.equal(result.errors[0].line, 2)
  assert.equal(result.errors[0].col, 1)
  assert.equal(result.errors[0].text, "if then")
})

test("zsh 中文报错（行 2）→ 拦截为 zsh-syntax", async (t) => {
  const { session, cleanup } = makeSession("zsh")
  t.after(cleanup)
  session._client = {
    exec(_command, _options, cb) {
      const ch = new FakeChannel(() => {
        ch.stderr.emit("data", "zsh: 行 2: 语法错误 在 `then' 附近\n")
        ch.emit("exit", 2)
        ch.emit("close")
      })
      cb(undefined, ch)
    },
  }
  const result = await session.precheckSyntax("echo ok\nif then")
  assert.equal(result.ok, false)
  assert.equal(result.errors[0].errorId, "zsh-syntax")
  assert.equal(result.errors[0].line, 2)
  assert.equal(result.errors[0].text, "if then")
})

test("非语法失败（退出码 127）→ 放行，绝不误拦", async (t) => {
  const { session, cleanup } = makeSession("bash")
  t.after(cleanup)
  session._client = {
    exec(_command, _options, cb) {
      const ch = new FakeChannel(() => {
        ch.stderr.emit("data", "bash: line 1: foo: command not found\n")
        ch.emit("exit", 127)
        ch.emit("close")
      })
      cb(undefined, ch)
    },
  }
  assert.deepEqual(await session.precheckSyntax("foo"), { ok: true })
})

test("通道打开失败 → 放行", async (t) => {
  const { session, cleanup } = makeSession("bash")
  t.after(cleanup)
  session._client = {
    exec(_command, _options, cb) {
      cb(new Error("channel open failed"))
    },
  }
  assert.deepEqual(await session.precheckSyntax("if then"), { ok: true })
})

test("通道 error 事件 → 放行", async (t) => {
  const { session, cleanup } = makeSession("bash")
  t.after(cleanup)
  session._client = {
    exec(_command, _options, cb) {
      const ch = new FakeChannel(() => {})
      cb(undefined, ch)
      ch.emit("error", new Error("channel reset"))
    },
  }
  assert.deepEqual(await session.precheckSyntax("if then"), { ok: true })
})

test("非 bash/zsh/pwsh（sh/cmd/未知）→ 直接放行，不开通道", async (t) => {
  for (const shell of ["sh", "cmd", "fish"]) {
    const { session, cleanup } = makeSession(shell)
    t.after(cleanup)
    session._client = {
      exec() {
        throw new Error("不应打开预检通道")
      },
    }
    assert.deepEqual(await session.precheckSyntax("if then"), { ok: true })
  }
})

test("未连接 → 直接放行，不开通道", async (t) => {
  const { session, cleanup } = makeSession("bash")
  t.after(cleanup)
  session._connected = false
  session._client = {
    exec() {
      throw new Error("不应打开预检通道")
    },
  }
  assert.deepEqual(await session.precheckSyntax("if then"), { ok: true })
})

/** 构造侧车响应行（条目为 [errorId, line, col, text]） */
function errCountLine(entries) {
  const body = entries
    .map(([errorId, line, col, text]) => `${errorId}:${line}:${col}:${Buffer.from(text, "utf8").toString("base64")}`)
    .join("|")
  return `ERRCOUNT=${entries.length}${entries.length ? `|${body}` : ""}`
}

/** 判断是否为某个候选解释器的固定启动命令（脚本经 -EncodedCommand 传入） */
function isPwshCommand(bin, command) {
  return command.startsWith(`${bin} -NoProfile -NonInteractive -NoLogo -EncodedCommand `)
}

test("pwsh ERRCOUNT=0 → 放行；独立通道 + 固定参数 + stdin 请求行", async (t) => {
  const { session, cleanup } = makeSession("pwsh")
  t.after(cleanup)
  let execArgs = null
  let wrote = null
  const script = "Get-ChildItem | Where-Object { $_.Name }"
  session._client = {
    exec(command, options, cb) {
      execArgs = { command, options }
      const ch = new FakeChannel((data) => {
        wrote = data
        ch.emit("data", "READY\r\nERRCOUNT=0\r\n")
        ch.emit("exit", 0)
        ch.emit("close")
      })
      cb(undefined, ch)
    },
  }
  assert.deepEqual(await session.precheckSyntax(script), { ok: true })
  assert.deepEqual(execArgs.options, { pty: false })
  assert.ok(isPwshCommand("pwsh", execArgs.command), execArgs.command)
  const prefix = "-EncodedCommand "
  const encoded = execArgs.command.slice(execArgs.command.indexOf(prefix) + prefix.length)
  assert.match(encoded, /^[A-Za-z0-9+/=]+$/) // 侧车脚本 ASCII-only → EncodedCommand 纯 base64
  assert.equal(wrote, `${Buffer.from(script, "utf8").toString("base64")}\n!QUIT\n`)
})

test("pwsh ERRCOUNT=1 → 拦截（保留侧车 ErrorId/行/列/片段）", async (t) => {
  const { session, cleanup } = makeSession("pwsh")
  t.after(cleanup)
  session._client = {
    exec(_command, _options, cb) {
      const ch = new FakeChannel(() => {
        ch.emit("data", `READY\r\n${errCountLine([["UnexpectedToken", 1, 7, "then"]])}\r\n`)
        ch.emit("exit", 0)
        ch.emit("close")
      })
      cb(undefined, ch)
    },
  }
  assert.deepEqual(await session.precheckSyntax("if then"), {
    ok: false,
    errors: [{ errorId: "UnexpectedToken", line: 1, col: 7, text: "then" }],
  })
})

test("pwsh ERROR=1（侧车内部异常）→ 放行，不重试其它候选", async (t) => {
  const { session, cleanup } = makeSession("pwsh")
  t.after(cleanup)
  let calls = 0
  session._client = {
    exec(_command, _options, cb) {
      calls += 1
      const ch = new FakeChannel(() => {
        ch.emit("data", "READY\r\nERROR=1\r\n")
        ch.emit("exit", 0)
        ch.emit("close")
      })
      cb(undefined, ch)
    },
  }
  assert.deepEqual(await session.precheckSyntax("if then"), { ok: true })
  assert.equal(calls, 1)
})

test("pwsh 不存在（exit 127）→ 回落 powershell，不误拦", async (t) => {
  const { session, cleanup } = makeSession("pwsh")
  t.after(cleanup)
  const seen = []
  session._client = {
    exec(command, _options, cb) {
      seen.push(command)
      if (command.startsWith("pwsh ")) {
        const ch = new FakeChannel(() => {
          ch.stderr.emit("data", "sh: 1: pwsh: not found\n")
          ch.emit("exit", 127)
          ch.emit("close")
        })
        cb(undefined, ch)
        return
      }
      const ch = new FakeChannel(() => {
        ch.emit("data", `READY\r\n${errCountLine([["UnexpectedToken", 2, 3, "else"]])}\r\n`)
        ch.emit("exit", 0)
        ch.emit("close")
      })
      cb(undefined, ch)
    },
  }
  const result = await session.precheckSyntax("if\nelse")
  assert.equal(result.ok, false)
  assert.equal(result.errors[0].text, "else")
  assert.equal(seen.length, 2)
  assert.ok(isPwshCommand("pwsh", seen[0]), seen[0])
  assert.ok(isPwshCommand("powershell", seen[1]), seen[1])
})

test("pwsh/powershell 都不存在 → 依次尝试后放行，不开 PTY", async (t) => {
  const { session, cleanup } = makeSession("pwsh")
  t.after(cleanup)
  const seen = []
  session._client = {
    exec(command, options, cb) {
      seen.push(command)
      assert.deepEqual(options, { pty: false })
      const ch = new FakeChannel(() => {
        ch.stderr.emit("data", "command not found\n")
        ch.emit("exit", 127)
        ch.emit("close")
      })
      cb(undefined, ch)
    },
  }
  assert.deepEqual(await session.precheckSyntax("if then"), { ok: true })
  assert.deepEqual(seen.map((c) => c.split(" ")[0]), ["pwsh", "powershell", "powershell.exe"])
})

test("pwsh 无协议响应（exit 1）→ 放行，不重试", async (t) => {
  const { session, cleanup } = makeSession("pwsh")
  t.after(cleanup)
  let calls = 0
  session._client = {
    exec(_command, _options, cb) {
      calls += 1
      const ch = new FakeChannel(() => {
        ch.emit("exit", 1)
        ch.emit("close")
      })
      cb(undefined, ch)
    },
  }
  assert.deepEqual(await session.precheckSyntax("if then"), { ok: true })
  assert.equal(calls, 1)
})

test("pwsh 命令超长 → 放行，不开通道", async (t) => {
  const { session, cleanup } = makeSession("pwsh")
  t.after(cleanup)
  session._client = {
    exec() {
      throw new Error("超长命令不应打开预检通道")
    },
  }
  assert.deepEqual(await session.precheckSyntax("a".repeat(40 * 1024)), { ok: true })
})

test("pwsh 通道打开失败 → 放行", async (t) => {
  const { session, cleanup } = makeSession("pwsh")
  t.after(cleanup)
  session._client = {
    exec(_command, _options, cb) {
      cb(new Error("channel open failed"))
    },
  }
  assert.deepEqual(await session.precheckSyntax("if then"), { ok: true })
})

test("pwsh 单候选超时 → timeout 结算并销毁通道", async (t) => {
  const { session, cleanup } = makeSession("pwsh")
  t.after(cleanup)
  let destroyed = false
  const channel = new FakeChannel(() => {})
  const originalDestroy = channel.destroy.bind(channel)
  channel.destroy = () => {
    destroyed = true
    originalDestroy()
  }
  const outcome = await session._runPwshCandidate(
    { exec: (_command, _options, cb) => cb(undefined, channel) },
    "pwsh",
    "cGF5bG9hZA==",
    10,
  )
  assert.deepEqual(outcome, { kind: "timeout" })
  assert.equal(destroyed, true)
})
