// exec/status 共享 timeout/poll 配置的解析与非法值回退
import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { loadConfig } from "../dist/config.js"

function withHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), "ssh-tool-config-"))
  const old = process.env.USERPROFILE
  process.env.USERPROFILE = dir
  try {
    return fn(dir)
  } finally {
    if (old === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = old
    rmSync(dir, { recursive: true, force: true })
  }
}

test("config：缺失文件使用 exec 默认 timeout/poll", () => {
  withHome(() => {
    const cfg = loadConfig()
    assert.deepEqual(cfg.exec, { timeoutMs: 5000, pollMs: 1000 })
  })
})

test("config：exec.timeoutMs/pollMs 读取与非法值回退", () => {
  withHome((dir) => {
    const cfgDir = join(dir, ".config", "opencode")
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(join(cfgDir, "ssh-tool.jsonc"), JSON.stringify({ exec: { timeoutMs: 0, pollMs: 250 } }), "utf8")
    assert.deepEqual(loadConfig().exec, { timeoutMs: 0, pollMs: 250 })

    writeFileSync(join(cfgDir, "ssh-tool.jsonc"), JSON.stringify({ exec: { timeoutMs: -1, pollMs: 0 } }), "utf8")
    assert.deepEqual(loadConfig().exec, { timeoutMs: 5000, pollMs: 1000 })
  })
})
