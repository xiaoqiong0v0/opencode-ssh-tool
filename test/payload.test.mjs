// 载荷解析单测：node:test + assert（需先 npm run build 产出 dist/payload.js）
import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { resolvePayload, normalizeExecText, PayloadError } from "../dist/payload.js"

/** 生成 base64（测试夹具） */
function b64(text) {
  return Buffer.from(text, "utf8").toString("base64")
}

test("默认 text：原样返回、raw=false", async () => {
  const r = await resolvePayload('echo "hi"', {})
  assert.equal(r.source, "text")
  assert.equal(r.raw, false)
  assert.equal(r.text, 'echo "hi"')
})

test("--base64：忽略空白并解码为 UTF-8，raw=true", async () => {
  const original = 'SELECT "x" FROM t'
  const encoded = b64(original)
  const folded = `${encoded.slice(0, 4)} \n ${encoded.slice(4)}`
  const r = await resolvePayload(folded, { base64: true })
  assert.equal(r.source, "base64")
  assert.equal(r.raw, true)
  assert.equal(r.text, original)
})

test("--base64：非法字符报 code=base64", async () => {
  await assert.rejects(
    () => resolvePayload("not*base64", { base64: true }),
    (err) => err instanceof PayloadError && err.code === "base64",
  )
})

test("--base64：长度不是 4 的倍数报 code=base64", async () => {
  await assert.rejects(
    () => resolvePayload("abc", { base64: true }),
    (err) => err instanceof PayloadError && err.code === "base64",
  )
})

test("--base64 与 --file 同时给：code=conflict", async () => {
  await assert.rejects(
    () => resolvePayload("abc", { base64: true, file: "x.txt" }),
    (err) => err instanceof PayloadError && err.code === "conflict",
  )
})

test("--file：读取本地 UTF-8 文件，raw=true", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ssh-tool-payload-"))
  const path = join(dir, "payload.txt")
  const content = 'echo "file payload"\n'
  try {
    await writeFile(path, content, "utf8")
    const r = await resolvePayload("", { file: path })
    assert.equal(r.source, "file")
    assert.equal(r.raw, true)
    assert.equal(r.text, content)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("--file：文件不存在报 code=file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ssh-tool-payload-"))
  const path = join(dir, "missing.txt")
  try {
    await assert.rejects(
      () => resolvePayload("", { file: path }),
      (err) => err instanceof PayloadError && err.code === "file",
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("--file：~ 展开为 home（临时改写 HOME/USERPROFILE）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ssh-tool-home-"))
  const prevHome = process.env.HOME
  const prevProfile = process.env.USERPROFILE
  try {
    process.env.HOME = dir
    process.env.USERPROFILE = dir
    await writeFile(join(dir, "tilde.txt"), "tilde payload", "utf8")
    const r = await resolvePayload("", { file: "~/tilde.txt" })
    assert.equal(r.source, "file")
    assert.equal(r.text, "tilde payload")
  } finally {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = prevProfile
    await rm(dir, { recursive: true, force: true })
  }
})

test("--file：UTF-8 BOM 被剥掉（文本无 U+FEFF）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ssh-tool-payload-"))
  const path = join(dir, "bom.txt")
  try {
    await writeFile(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("echo hi\n", "utf8")]))
    const r = await resolvePayload("", { file: path })
    assert.equal(r.text, "echo hi\n")
    assert.equal(r.text.includes("\uFEFF"), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("--file：UTF-16LE 文件报 code=decode（不静默发送）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ssh-tool-payload-"))
  const path = join(dir, "utf16.txt")
  try {
    // PowerShell Out-File 默认带 BOM 的 UTF-16LE
    await writeFile(path, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("echo hi\r\n", "utf16le")]))
    await assert.rejects(
      () => resolvePayload("", { file: path }),
      (err) => err instanceof PayloadError && err.code === "decode",
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("--base64：解码含 NUL 报 code=decode", async () => {
  await assert.rejects(
    () => resolvePayload(b64("echo\0hi"), { base64: true }),
    (err) => err instanceof PayloadError && err.code === "decode",
  )
})

test("--base64：非法 UTF-8 报 code=decode", async () => {
  const invalid = Buffer.from([0xff, 0xfe, 0x41]).toString("base64")
  await assert.rejects(
    () => resolvePayload(invalid, { base64: true }),
    (err) => err instanceof PayloadError && err.code === "decode",
  )
})

test("--base64：BOM 被剥掉；合法中文/emoji/空文件正常", async () => {
  const r = await resolvePayload(b64("\uFEFF你好 🚀"), { base64: true })
  assert.equal(r.text, "你好 🚀")
  const dir = await mkdtemp(join(tmpdir(), "ssh-tool-payload-"))
  const path = join(dir, "empty.txt")
  try {
    await writeFile(path, "", "utf8")
    const empty = await resolvePayload("", { file: path })
    assert.equal(empty.text, "")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("normalizeExecText：仅 CRLF 归一为 LF", () => {
  assert.equal(normalizeExecText("a\r\nb\r\n"), "a\nb\n")
  assert.equal(normalizeExecText("a\nb\r\nc"), "a\nb\nc")
  assert.equal(normalizeExecText("a\rb"), "a\rb")
})
