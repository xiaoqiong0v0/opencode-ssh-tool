// CLI 分词单测：node:test + assert（需先 npm run build 产出 dist/cli-args.js）
import test from "node:test"
import assert from "node:assert/strict"

import { parseCliArgs, splitCliArgs } from "../dist/cli-args.js"
import { decodeTerminalEscapes } from "../dist/escapes.js"

test("exec 双引号命令 + 选项", () => {
  assert.deepEqual(splitCliArgs('exec "cat /tmp/x" -w'), ["exec", "cat /tmp/x", "-w"])
})

test('send 双引号内 \\" 原样保留，收尾引号不进入 payload', () => {
  const tokens = splitCliArgs('send "echo \\"hi\\""')
  assert.equal(tokens.length, 2)
  assert.equal(tokens[0], "send")
  const payload = tokens[1]
  assert.ok(payload.includes('\\"'), `payload 应含 \\"：${JSON.stringify(payload)}`)
  // 末尾不能是未被反斜杠转义的孤立引号
  assert.ok(!/(?<!\\)"$/.test(payload), `payload 不应以孤立 " 结尾：${JSON.stringify(payload)}`)
})

test("用户现场：多行 heredoc send 得到单个完整 payload", () => {
  // 模型传入的是转义文本：\" 为反斜杠+引号，\n 为反斜杠+n（后续交 decodeTerminalEscapes）
  const raw = String.raw`send "cat > /tmp/pm_menu_upd.sql <<'EOSQL'\nDELETE FROM menu;\nINSERT INTO menu VALUES ('[{\"path\":\"/statistics\"}]');\nEOSQL\n"`
  const tokens = splitCliArgs(raw)
  assert.equal(tokens.length, 2)
  const payload = tokens[1]
  assert.ok(payload.includes('\\"path\\"'), `payload 应含 \\"path\\"：${JSON.stringify(payload)}`)
  assert.ok(payload.endsWith("EOSQL\\n"), `payload 应以 EOSQL\\n 结尾：${JSON.stringify(payload.slice(-20))}`)
  assert.ok(!/(?<!\\)"$/.test(payload), `payload 末尾不应有多余 "：${JSON.stringify(payload.slice(-20))}`)
  const sent = decodeTerminalEscapes(payload)
  assert.ok(sent.endsWith("EOSQL\r"), `解码后应以 EOSQL\\r 结尾：${JSON.stringify(sent.slice(-20))}`)
  assert.ok(!/(?<!\\)"$/.test(sent), `解码后末尾不应有多余 "：${JSON.stringify(sent.slice(-20))}`)
})

test("用户现场：实际换行 heredoc 也不会泄漏收尾引号", () => {
  const raw = `send "cat > /tmp/pm_menu_upd.sql <<'EOSQL'
UPDATE erp_sys.sys_app_project SET project_route_settings = '[{\\"path\\":\\"/statistics\\"}]' WHERE app_id = 266;
EOSQL
"`
  const tokens = splitCliArgs(raw)
  assert.equal(tokens.length, 2)
  const payload = tokens[1]
  assert.ok(payload.includes('\\"path\\"'), `payload 应含 \\"path\\"：${JSON.stringify(payload)}`)
  assert.ok(payload.endsWith("EOSQL\n"), `payload 应以 EOSQL\\n 结尾：${JSON.stringify(payload.slice(-20))}`)
  assert.ok(!/(?<!\\)"$/.test(payload), `payload 末尾不应有多余 "：${JSON.stringify(payload.slice(-20))}`)
  const sent = decodeTerminalEscapes(payload)
  assert.ok(sent.endsWith("EOSQL\n"), `解码后应以 EOSQL\\n 结尾：${JSON.stringify(sent.slice(-20))}`)
  assert.ok(!/(?<!\\)"$/.test(sent), `解码后末尾不应有多余 "：${JSON.stringify(sent.slice(-20))}`)
})

test("单引号包裹", () => {
  assert.deepEqual(splitCliArgs("exec 'echo hi'"), ["exec", "echo hi"])
  assert.deepEqual(splitCliArgs(`exec 'Write-Output "hi"'`), ["exec", `Write-Output "hi"`])
  assert.deepEqual(splitCliArgs(`send "a'b"`), ["send", "a'b"])
  assert.deepEqual(splitCliArgs(`send 'a"b'`), ["send", 'a"b'])
})

test("未闭合单引号也会被报告", () => {
  assert.equal(parseCliArgs("send 'abc").unclosedQuote, true)
})

test("未加引号的 token", () => {
  assert.deepEqual(splitCliArgs("exec ls -la"), ["exec", "ls", "-la"])
})

test('send 控制字符写法 \\x03 保留', () => {
  assert.deepEqual(splitCliArgs('send "\\x03"'), ["send", "\\x03"])
})

test("空引号与空输入", () => {
  assert.deepEqual(splitCliArgs('send ""'), ["send", ""])
  assert.deepEqual(splitCliArgs(""), [])
})

test("未闭合引号会被报告，正常引号不会", () => {
  const bad = parseCliArgs('exec "abc')
  assert.equal(bad.unclosedQuote, true)
  assert.deepEqual(bad.tokens, ["exec", "abc"])
  assert.equal(parseCliArgs('exec "abc"').unclosedQuote, false)
})

test("引号内反斜杠、引号拼接等分支", () => {
  assert.deepEqual(splitCliArgs('send "a\\\\b"'), ["send", "a\\\\b"])
  assert.deepEqual(parseCliArgs('send "tail\\').unclosedQuote, true)
  assert.deepEqual(splitCliArgs('exec "a b"c'), ["exec", "a bc"])
})

test("-- 终止选项：载荷以 - 开头不被当作选项", () => {
  assert.deepEqual(splitCliArgs('send -- "-n"'), ["send", "--", "-n"])
  assert.deepEqual(splitCliArgs('exec -- "-x"'), ["exec", "--", "-x"])
})
