// shell 适配器语法错误识别回归：英文/中文 POSIX 报错要能触发自动收尾，程序输出里的普通 syntax error 不误判。
import test from "node:test"
import assert from "node:assert/strict"

import { adapters, detectSyntaxError } from "../dist/shell-adapter.js"

const bash = adapters.find((a) => a.name === "bash")

test("bash：识别英文 syntax error", () => {
  assert.ok(bash)
  assert.equal(detectSyntaxError(bash, "bash: syntax error near unexpected token `('\n", 0), true)
})

test("bash：识别中文“未预期的记号 / 语法错误”", () => {
  assert.ok(bash)
  assert.equal(detectSyntaxError(bash, "-bash: 未预期的记号 \"(\" 附近有语法错误\n", 0), true)
  assert.equal(detectSyntaxError(bash, "bash: 未预期的文件结尾\n", 0), true)
  assert.equal(detectSyntaxError(bash, "bash: 语法错误 在 `;` 附近\n", 0), true)
})

test("程序输出里的裸 syntax error 不误判", () => {
  assert.ok(bash)
  assert.equal(detectSyntaxError(bash, "myapp: syntax error while parsing config\n", 0), false)
})
