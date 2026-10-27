// 发送前语法预检单测：本地走 parse-check，远程走会话 precheckSyntax（独立通道），
// 远程异常/超时/未实现一律 fail-open（返回 null，不阻塞命令）。
import test from "node:test"
import assert from "node:assert/strict"

import { precheckBeforeExec, pickSyntaxErrorText } from "../dist/precheck.js"
import {
  encodePwshSidecarPayload,
  parsePwshSidecarResponse,
  PS_SIDECAR_ENCODED_COMMAND,
} from "../dist/parse-check.js"

/** 构造一条"确认语法错误"的远程预检结果 */
const syntaxError = (errorId = "bash-syntax") => ({
  ok: false,
  errors: [{ errorId, line: 1, col: 1, text: "if" }],
})

test("远程：precheckSyntax 返回 ok → 放行（且收到剥尾后的命令体）", async () => {
  let received = null
  const session = {
    shellName: "bash",
    isLocal: false,
    precheckSyntax: async (command) => {
      received = command
      return { ok: true }
    },
  }
  assert.equal(await precheckBeforeExec(session, "echo hi &&", undefined, "en"), null)
  assert.equal(received, "echo hi") // 尾运算符已剥掉，避免把实际可发送的命令误判
})

test("远程：返回 errors → 拦截文案含 precheck_failed 与 ErrorId", async () => {
  const session = {
    shellName: "bash",
    isLocal: false,
    precheckSyntax: async () => syntaxError(),
  }
  const rejection = await precheckBeforeExec(session, "if", undefined, "en")
  assert.equal(typeof rejection, "string")
  assert.ok(rejection.includes("Pre-exec syntax check failed"), rejection)
  assert.ok(rejection.includes("bash-syntax"), rejection)
})

test("远程：precheckSyntax 抛异常 → 放行", async () => {
  const session = {
    shellName: "zsh",
    isLocal: false,
    precheckSyntax: async () => {
      throw new Error("boom")
    },
  }
  assert.equal(await precheckBeforeExec(session, "echo hi", undefined, "en"), null)
})

test("远程：precheckSyntax 超时 → 放行（不等待主命令）", async () => {
  const session = {
    shellName: "bash",
    isLocal: false,
    precheckSyntax: () => new Promise(() => {}), // 永不兑现
  }
  assert.equal(await precheckBeforeExec(session, "echo hi", undefined, "en", 20), null)
})

test("远程：未实现 precheckSyntax → 放行（不调用本地校验器）", async () => {
  let localCalls = 0
  const session = { shellName: "bash", isLocal: false }
  const validate = async () => {
    localCalls += 1
    return syntaxError()
  }
  assert.equal(await precheckBeforeExec(session, "if", validate, "en"), null)
  assert.equal(localCalls, 0)
})

test("远程：返回结构异常（ok:false 但无 errors）→ 放行", async () => {
  const session = {
    shellName: "bash",
    isLocal: false,
    precheckSyntax: async () => ({ ok: false, errors: [] }),
  }
  assert.equal(await precheckBeforeExec(session, "echo hi", undefined, "en"), null)
})

test("本地：仍走原 parse-check 路径（命中即拦，且不调用远程方法）", async () => {
  let remoteCalls = 0
  const session = {
    shellName: "bash",
    isLocal: true,
    precheckSyntax: async () => {
      remoteCalls += 1
      return { ok: true }
    },
  }
  const validate = async (shell, text) => {
    assert.equal(shell, "bash")
    assert.equal(text, "if")
    return syntaxError()
  }
  const rejection = await precheckBeforeExec(session, "if", validate, "en")
  assert.ok(rejection?.includes("bash-syntax"), rejection)
  assert.equal(remoteCalls, 0)
})

test("本地：校验器抛异常 → 放行", async () => {
  const session = { shellName: "bash", isLocal: true }
  const validate = async () => {
    throw new Error("boom")
  }
  assert.equal(await precheckBeforeExec(session, "echo hi", validate, "en"), null)
})

test("pickSyntaxErrorText：优先命令行、回退 stderr 首行并限长", () => {
  assert.equal(pickSyntaxErrorText("echo ok\nif then", 2, "bash: line 2: syntax error"), "if then")
  assert.equal(pickSyntaxErrorText("echo ok", 0, "bash: line 1: syntax error\nmore"), "bash: line 1: syntax error")
  assert.equal(pickSyntaxErrorText("", 1, "x".repeat(500)).length, 201) // 200 + 省略号
})

test("远程 pwsh：precheckSyntax 返回 ParseIssue → 拦截文案含真实 ErrorId", async () => {
  const session = {
    shellName: "pwsh",
    isLocal: false,
    precheckSyntax: async () => ({
      ok: false,
      errors: [{ errorId: "UnexpectedToken", line: 2, col: 5, text: "else" }],
    }),
  }
  const rejection = await precheckBeforeExec(session, "if\nelse", undefined, "en")
  assert.ok(rejection?.includes("UnexpectedToken"), rejection)
  assert.ok(rejection?.includes("else"), rejection)
})

test("parsePwshSidecarResponse：ERRCOUNT=0 通过；条目按侧车协议解出", () => {
  assert.deepEqual(parsePwshSidecarResponse("ERRCOUNT=0"), [])
  const text = Buffer.from("坏 'x'", "utf8").toString("base64")
  const errors = parsePwshSidecarResponse(`ERRCOUNT=1|UnexpectedToken:3:4:${text}`)
  assert.deepEqual(errors, [{ errorId: "UnexpectedToken", line: 3, col: 4, text: "坏 'x'" }])
  assert.equal(parsePwshSidecarResponse("READY"), null)
})

test("PS_SIDECAR_ENCODED_COMMAND / encodePwshSidecarPayload：协议与编码稳定", () => {
  const script = Buffer.from(PS_SIDECAR_ENCODED_COMMAND, "base64").toString("utf16le")
  assert.ok(script.includes("ERRCOUNT="))
  assert.match(PS_SIDECAR_ENCODED_COMMAND, /^[A-Za-z0-9+/=]+$/)
  assert.equal(encodePwshSidecarPayload("echo 你好"), Buffer.from("echo 你好", "utf8").toString("base64"))
})
