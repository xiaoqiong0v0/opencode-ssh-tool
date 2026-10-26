// 文件传输单测：node:test + assert（需先 npm run build 产出 dist/transfer.js / dist/session.js）
// 不依赖真实 SSH/网络：用临时目录 + fake SFTP（实现 stat/lstat/mkdir/rename/unlink/realpath/读写流/destroy）
import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { uploadFile, downloadFile, TransferError, assertTransferCapable, parseTransferPositionals } from "../dist/transfer.js"
import { LocalSession } from "../dist/local-session.js"
import { SshSession, runSshTransfer } from "../dist/session.js"
import { FakeSftp } from "./helpers/fake-sftp.mjs"

/** 创建临时工作目录并在结束后清理 */
async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "ssh-tool-transfer-"))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** 某目录下是否残留 .part 临时文件 */
async function partFiles(dir) {
  return (await readdir(dir)).filter((f) => f.includes(".opencode-ssh-tool-") && f.endsWith(".part"))
}

/** fake SFTP 中是否残留临时/备份文件 */
function partNodes(sftp) {
  return [...sftp.nodes.keys()].filter((p) => p.includes(".opencode-ssh-tool-"))
}

/** 构造未连接的 SshSession（仅用于 index 层判定/排序测试） */
function unconnectedSshSession() {
  return new SshSession("sid-ssh", { dispose() {} }, "default", "en", 5000)
}

test("upload：目标已存在且无 --overwrite → exists，且不打开独占写流", async () => {
  await withTempDir(async (dir) => {
    const local = join(dir, "a.txt")
    await writeFile(local, "new-content")
    const sftp = new FakeSftp()
    sftp.setFile("dest.txt", "old-content")

    await assert.rejects(
      () => uploadFile({ sftp, localPath: local, remotePath: "dest.txt" }),
      (err) => err instanceof TransferError && err.code === "exists",
    )
    assert.equal(sftp.writeCalls.length, 0, "目标存在时不应开始传输")
    assert.equal(sftp.node("dest.txt").data.toString(), "old-content", "目标内容不得被改动")
  })
})

test("upload：ssh2 SFTP 写流只 emit close、不 emit finish 也能结算", async () => {
  await withTempDir(async (dir) => {
    const local = join(dir, "close-only.txt")
    await writeFile(local, "close-only")
    const sftp = new FakeSftp()
    sftp.closeOnlyWrite = true

    const result = await uploadFile({ sftp, localPath: local, remotePath: "close-only.txt" })
    assert.equal(result.bytes, Buffer.byteLength("close-only"))
    assert.equal(sftp.node("close-only.txt").data.toString(), "close-only")
  })
})

test("upload：SFTP 写流提前 close（短写）→ io 错误，不得按 done 结算", async () => {
  await withTempDir(async (dir) => {
    const local = join(dir, "large.bin")
    // 多块数据（> fs 读流 highWaterMark），确保提前 close 时读取字节数少于 stat 大小
    await writeFile(local, Buffer.alloc(256 * 1024, 0x61))
    const sftp = new FakeSftp()
    sftp.closeEarlyWrite = true

    await assert.rejects(
      () => uploadFile({ sftp, localPath: local, remotePath: "short.bin" }),
      (err) => err instanceof TransferError && err.code === "io" && /incomplete transfer/i.test(err.message),
    )
    assert.deepEqual(partNodes(sftp), [], "短写失败后不应残留临时/部分文件")
    assert.equal(sftp.node("short.bin"), undefined, "目标不得被当成完整文件留下")
  })
})

test("upload：默认独占创建（wx）直接写目标；--overwrite 才写临时文件再 rename", async () => {
  await withTempDir(async (dir) => {
    const local = join(dir, "a.txt")
    await writeFile(local, "new-content")
    const sftp = new FakeSftp()

    const created = await uploadFile({ sftp, localPath: local, remotePath: "dest.txt" })
    assert.equal(created.bytes, Buffer.byteLength("new-content"), "字节数取自实际写流")
    assert.equal(sftp.writeCalls[0].path, "/dest.txt")
    assert.equal(sftp.writeCalls[0].flags, "wx", "默认必须用独占创建")
    assert.equal(sftp.renameCalls.length, 0, "默认不覆盖不应 rename")

    sftp.setFile("dest2.txt", "old-content")
    const overwritten = await uploadFile({ sftp, localPath: local, remotePath: "dest2.txt", overwrite: true })
    const tempCall = sftp.writeCalls[1]
    assert.ok(tempCall.path.endsWith(".part"), `overwrite 应先写临时文件：${tempCall.path}`)
    assert.equal(tempCall.flags, "w")
    const rename = sftp.renameCalls.find((r) => r.src === tempCall.path && r.dest === "/dest2.txt")
    assert.ok(rename, `临时文件应 rename 到目标：${JSON.stringify(sftp.renameCalls)}`)
    assert.equal(sftp.node("dest2.txt").data.toString(), "new-content")
    assert.equal(overwritten.bytes, Buffer.byteLength("new-content"))
  })
})

test("download：无 --overwrite 本地目标存在 → exists；默认独占创建；--overwrite 临时文件 + rename", async () => {
  await withTempDir(async (dir) => {
    const sftp = new FakeSftp()
    sftp.setFile("src.txt", "from-remote")
    const local = join(dir, "out.txt")
    await writeFile(local, "old-local")

    await assert.rejects(
      () => downloadFile({ sftp, remotePath: "src.txt", localPath: local }),
      (err) => err instanceof TransferError && err.code === "exists",
    )
    assert.equal(sftp.readCalls.length, 0)

    const overwritten = await downloadFile({ sftp, remotePath: "src.txt", localPath: local, overwrite: true })
    assert.equal(overwritten.bytes, Buffer.byteLength("from-remote"))
    assert.equal(await readFile(local, "utf8"), "from-remote")
    assert.deepEqual(await partFiles(dir), [], "rename 后不应残留临时文件")

    // 默认独占创建：目标不存在时直接写目标（无临时文件）
    const fresh = join(dir, "fresh.txt")
    await downloadFile({ sftp, remotePath: "src.txt", localPath: fresh })
    assert.equal(await readFile(fresh, "utf8"), "from-remote")
    assert.deepEqual(await partFiles(dir), [])
  })
})

test("upload：--mkdir 递归创建父目录；未加 --mkdir 时 parent_missing", async () => {
  await withTempDir(async (dir) => {
    const local = join(dir, "a.txt")
    await writeFile(local, "x")
    const sftp = new FakeSftp()

    await assert.rejects(
      () => uploadFile({ sftp, localPath: local, remotePath: "a/b/c.txt" }),
      (err) => err instanceof TransferError && err.code === "parent_missing",
    )
    assert.equal(sftp.writeCalls.length, 0)

    await uploadFile({ sftp, localPath: local, remotePath: "a/b/c.txt", mkdir: true })
    assert.deepEqual(sftp.mkdirCalls, ["a", "a/b"], "应按层级递归创建（父 → 子）")
    assert.equal(sftp.node("a/b/c.txt").data.toString(), "x")
  })
})

test("download：父目录不存在 → parent_missing；--mkdir 递归创建本地父目录", async () => {
  await withTempDir(async (dir) => {
    const sftp = new FakeSftp()
    sftp.setFile("src.txt", "payload")
    const target = join(dir, "x", "y", "out.txt")

    await assert.rejects(
      () => downloadFile({ sftp, remotePath: "src.txt", localPath: target }),
      (err) => err instanceof TransferError && err.code === "parent_missing",
    )
    assert.equal(sftp.readCalls.length, 0)

    await downloadFile({ sftp, remotePath: "src.txt", localPath: target, mkdir: true })
    assert.equal(await readFile(target, "utf8"), "payload")
  })
})

test("目录/符号链接拒绝：本地目录、远端目录、远端符号链接", async () => {
  await withTempDir(async (dir) => {
    const localDir = join(dir, "folder")
    await mkdir(localDir)
    const sftp = new FakeSftp()

    await assert.rejects(
      () => uploadFile({ sftp, localPath: localDir, remotePath: "x.txt" }),
      (err) => err instanceof TransferError && err.code === "local_is_dir",
    )

    sftp.nodes.set(sftp.norm("remote-dir"), { type: "dir" })
    await assert.rejects(
      () => downloadFile({ sftp, remotePath: "remote-dir", localPath: join(dir, "out.txt") }),
      (err) => err instanceof TransferError && err.code === "remote_is_dir",
    )

    sftp.setFile("real.txt", "real")
    sftp.nodes.set(sftp.norm("link.txt"), { type: "symlink", target: "real.txt" })
    await assert.rejects(
      () => downloadFile({ sftp, remotePath: "link.txt", localPath: join(dir, "out2.txt") }),
      (err) => err instanceof TransferError && err.code === "symlink",
    )
    const localSource = join(dir, "local-source.txt")
    await writeFile(localSource, "local")
    await assert.rejects(
      () => uploadFile({ sftp, localPath: localSource, remotePath: "link.txt", overwrite: true }),
      (err) => err instanceof TransferError && err.code === "symlink",
    )
    assert.equal(sftp.writeCalls.length, 0)
    assert.equal(sftp.readCalls.length, 0)
  })
})

test("本地符号链接拒绝（平台不支持创建时跳过该段，远端符号链接已覆盖）", async (t) => {
  await withTempDir(async (dir) => {
    const real = join(dir, "real.txt")
    await writeFile(real, "x")
    const link = join(dir, "link.txt")
    let created = true
    try {
      await symlink(real, link, "file")
    } catch {
      created = false
    }
    if (!created) {
      t.diagnostic("当前平台不允许创建符号链接（Windows 需开发者模式/管理员），跳过本地符号链接段")
      return
    }
    const sftp = new FakeSftp()
    await assert.rejects(
      () => uploadFile({ sftp, localPath: link, remotePath: "x.txt" }),
      (err) => err instanceof TransferError && err.code === "symlink",
    )
    assert.equal(sftp.writeCalls.length, 0)
  })
})

test("大小上限：上传/下载超过 maxBytes 均拒绝且不开始传输", async () => {
  await withTempDir(async (dir) => {
    const local = join(dir, "big.bin")
    await writeFile(local, Buffer.alloc(8, 1))
    const sftp = new FakeSftp()
    sftp.setFile("remote-big.bin", Buffer.alloc(8, 2))

    await assert.rejects(
      () => uploadFile({ sftp, localPath: local, remotePath: "up.bin", maxBytes: 4 }),
      (err) => err instanceof TransferError && err.code === "too_large",
    )
    await assert.rejects(
      () => downloadFile({ sftp, remotePath: "remote-big.bin", localPath: join(dir, "down.bin"), maxBytes: 4 }),
      (err) => err instanceof TransferError && err.code === "too_large",
    )
    assert.equal(sftp.writeCalls.length, 0)
    assert.equal(sftp.readCalls.length, 0)
  })
})

test("local ~ 展开、路径含空格/中文、远端 ~/ 由 SFTP 展开", async () => {
  await withTempDir(async (dir) => {
    const prevHome = process.env.HOME
    const prevProfile = process.env.USERPROFILE
    process.env.HOME = dir
    process.env.USERPROFILE = dir
    try {
      const localName = "有 空格.txt"
      await writeFile(join(dir, localName), "中文内容 with space")
      const sftp = new FakeSftp()

      const up = await uploadFile({ sftp, localPath: `~/${localName}`, remotePath: "~/目标 文件.txt" })
      assert.equal(sftp.writeCalls[0].path, "/home/tester/目标 文件.txt", "远端 ~/ 应经 realpath(.) 展开")
      assert.equal(up.remotePath, "/home/tester/目标 文件.txt")
      assert.equal(sftp.node("/home/tester/目标 文件.txt").data.toString(), "中文内容 with space")

      const down = await downloadFile({ sftp, remotePath: "~/目标 文件.txt", localPath: "~/下载 结果.txt" })
      assert.equal(down.localPath, join(dir, "下载 结果.txt"))
      assert.equal(await readFile(join(dir, "下载 结果.txt"), "utf8"), "中文内容 with space")
    } finally {
      if (prevHome === undefined) delete process.env.HOME
      else process.env.HOME = prevHome
      if (prevProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = prevProfile
    }
  })
})

test("二进制内容原样（含 NUL）：上传→下载字节级一致，字节数为实际计数", async () => {
  await withTempDir(async (dir) => {
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x41, 0x0a, 0x0d, 0x00, 0x7f])
    const local = join(dir, "in.bin")
    await writeFile(local, bytes)
    const sftp = new FakeSftp()

    const up = await uploadFile({ sftp, localPath: local, remotePath: "bin/data.bin", mkdir: true })
    assert.equal(up.bytes, bytes.length)
    const out = join(dir, "out.bin")
    const down = await downloadFile({ sftp, remotePath: "bin/data.bin", localPath: out })
    assert.equal(down.bytes, bytes.length)
    assert.deepEqual(await readFile(out), bytes, "下载内容必须与原始字节完全一致（含 NUL）")
  })
})

test("上传失败清理临时/部分文件", async () => {
  await withTempDir(async (dir) => {
    const local = join(dir, "a.txt")
    await writeFile(local, "payload")
    const sftp = new FakeSftp()
    sftp.failWrite = new Error("disk full")

    await assert.rejects(
      () => uploadFile({ sftp, localPath: local, remotePath: "x.txt" }),
      (err) => err instanceof TransferError && err.code === "io",
    )
    assert.deepEqual(partNodes(sftp), [], "失败后远端不应残留临时/部分文件")
  })
})

test("下载失败清理本地部分文件", async () => {
  await withTempDir(async (dir) => {
    const remoteOk = new FakeSftp()
    remoteOk.failRead = new Error("network reset")
    remoteOk.setFile("ok.txt", "remote-bytes")
    await assert.rejects(
      () => downloadFile({ sftp: remoteOk, remotePath: "ok.txt", localPath: join(dir, "out.txt") }),
      (err) => err instanceof TransferError && err.code === "io",
    )
    assert.deepEqual(await partFiles(dir), [], "失败后本地不应残留临时文件")
    assert.equal((await readdir(dir)).some((f) => f.endsWith("out.txt")), false, "失败后本地目标不应残留")
  })
})

test("overwrite 上传：rename 失败时备份旧目标→新文件就位→回滚安全", async () => {
  await withTempDir(async (dir) => {
    const local = join(dir, "a.txt")
    await writeFile(local, "new")
    const sftp = new FakeSftp()
    sftp.setFile("dest.txt", "old")
    // 第一次 temp→target 失败；后续（target→backup、temp→target）成功
    let failedOnce = false
    sftp.failRename = (src, dest) => {
      if (!failedOnce && src.endsWith(".part") && dest === "/dest.txt") {
        failedOnce = true
        return true
      }
      return false
    }

    await uploadFile({ sftp, localPath: local, remotePath: "dest.txt", overwrite: true })
    assert.equal(sftp.node("dest.txt").data.toString(), "new")
    assert.equal(sftp.renameCalls.length, 3, `应有 3 次 rename：${JSON.stringify(sftp.renameCalls)}`)
    assert.deepEqual(partNodes(sftp), [], "提交成功后不应残留备份/临时文件")
  })
})

test("overwrite 上传：第二次 rename 失败 → 回滚旧目标，错误可诊断", async () => {
  await withTempDir(async (dir) => {
    const local = join(dir, "a.txt")
    await writeFile(local, "new")
    const sftp = new FakeSftp()
    sftp.setFile("dest.txt", "old")
    // 任何 temp→target 都失败；target→backup 与 rollback 成功
    sftp.failRename = (src, dest) => src.endsWith(".part") && dest === "/dest.txt"

    await assert.rejects(
      () => uploadFile({ sftp, localPath: local, remotePath: "dest.txt", overwrite: true }),
      (err) => err instanceof TransferError && err.code === "io",
    )
    assert.equal(sftp.node("dest.txt").data.toString(), "old", "回滚后旧目标必须保留")
    assert.deepEqual(partNodes(sftp), [], "失败后不应残留备份/临时文件")
  })
})

test("超时：开通道后的 realpath 挂起 → timeout，且不写/不 rename", async () => {
  await withTempDir(async (dir) => {
    const local = join(dir, "a.txt")
    await writeFile(local, "x")
    const sftp = new FakeSftp()
    sftp.hangRealpath = true
    const started = Date.now()
    await assert.rejects(
      () => uploadFile({ sftp, localPath: local, remotePath: "~/x.txt", timeoutMs: 50 }),
      (err) => err instanceof TransferError && err.code === "timeout",
    )
    assert.ok(Date.now() - started < 2_000, "超时不应被挂死")
    assert.equal(sftp.writeCalls.length, 0)
    assert.equal(sftp.renameCalls.length, 0)
    assert.equal(sftp.destroyed, true, "超时应中止 SFTP 通道")
  })
})

test("超时：写流挂起 → timeout，且超时后不提交 rename", async () => {
  await withTempDir(async (dir) => {
    const local = join(dir, "a.txt")
    await writeFile(local, "x")
    const sftp = new FakeSftp()
    sftp.setFile("dest.txt", "old")
    sftp.hangWrite = true
    await assert.rejects(
      () => uploadFile({ sftp, localPath: local, remotePath: "dest.txt", overwrite: true, timeoutMs: 50 }),
      (err) => err instanceof TransferError && err.code === "timeout",
    )
    assert.equal(sftp.renameCalls.length, 0, "超时后不得 rename/commit")
    assert.equal(sftp.destroyed, true)
  })
})

test("远端路径策略：接受 C:/a/b（正斜杠），拒绝 C:\\a\\b 反斜杠盘符；~user 专用错误码", async () => {
  await withTempDir(async (dir) => {
    const local = join(dir, "a.txt")
    await writeFile(local, "x")
    const sftp = new FakeSftp()

    await uploadFile({ sftp, localPath: local, remotePath: "C:/a/b.txt", mkdir: true })
    assert.deepEqual(sftp.mkdirCalls, ["C:/a"])
    assert.equal(sftp.node("C:/a/b.txt").data.toString(), "x")

    await assert.rejects(
      () => uploadFile({ sftp, localPath: local, remotePath: "C:\\a\\b.txt" }),
      (err) => err instanceof TransferError && err.code === "remote_path_backslash",
    )
    await assert.rejects(
      () => uploadFile({ sftp, localPath: local, remotePath: "~root/x.txt" }),
      (err) => err instanceof TransferError && err.code === "tilde_user",
    )
  })
})

test("Windows 远端盘符：C:/a.txt 的覆盖临时文件与目标同目录", async () => {
  await withTempDir(async (dir) => {
    const local = join(dir, "a.txt")
    await writeFile(local, "new")
    const sftp = new FakeSftp()
    sftp.setFile("C:/a.txt", "old")

    await uploadFile({ sftp, localPath: local, remotePath: "C:/a.txt", overwrite: true })
    const tempCall = sftp.writeCalls[0]
    assert.ok(tempCall.path.startsWith("/C:/."), `临时文件应落在 C:/ 根：${tempCall.path}`)
    assert.ok(tempCall.path.endsWith(".part"))
    assert.equal(sftp.node("C:/a.txt").data.toString(), "new")
  })
})

test("参数个数：必须恰好 2 个路径（多给返回 null → index 报用法）", () => {
  assert.deepEqual(parseTransferPositionals(["a", "b"]), { first: "a", second: "b" })
  assert.equal(parseTransferPositionals(["a"]), null)
  assert.equal(parseTransferPositionals(["a", "b", "c"]), null)
  assert.equal(parseTransferPositionals(["", "b"]), null)
})

test("index 层顺序：非 SSH 会话直接拒绝；审批在传输前；拒绝审批不传输", async () => {
  const local = new LocalSession("sid-local", { dispose() {} }, "default", "en", 5000)
  let asked = 0
  let ran = 0
  await assert.rejects(
    () => runSshTransfer({ session: local, ask: async () => { asked++ }, run: async () => { ran++; return "x" } }),
    (err) => err instanceof TransferError && err.code === "ssh_only",
  )
  assert.equal(asked, 0, "本地会话不应触发审批")
  assert.equal(ran, 0, "本地会话不应执行传输")

  const ssh = unconnectedSshSession()
  const order = []
  const result = await runSshTransfer({
    session: ssh,
    ask: async () => { order.push("ask") },
    run: async (s) => {
      assert.equal(s, ssh)
      order.push("run")
      return "ok"
    },
  })
  assert.equal(result, "ok")
  assert.deepEqual(order, ["ask", "run"], "顺序必须是先审批后传输")

  await assert.rejects(
    () => runSshTransfer({
      session: ssh,
      ask: async () => { throw new Error("denied") },
      run: async () => { ran++; return "never" },
    }),
    (err) => err instanceof TransferError && err.code === "denied",
  )
  assert.equal(ran, 0, "拒绝审批后不得执行传输")
})

test("overwrite 上传：第二次 rename 失败且回滚也失败 → io 错误 detail 给出备份路径", async () => {
  await withTempDir(async (dir) => {
    const local = join(dir, "a.txt")
    await writeFile(local, "new")
    const sftp = new FakeSftp()
    sftp.setFile("dest.txt", "old")
    // temp→target 失败；target→backup 成功；随后 temp→target 仍失败；最后 backup→target（回滚）也失败
    sftp.failRename = (src, dest) => {
      if (dest !== "/dest.txt") return false
      return src.endsWith(".part") || src.endsWith(".bak")
    }

    let caught
    await assert.rejects(
      () => uploadFile({ sftp, localPath: local, remotePath: "dest.txt", overwrite: true }),
      (err) => {
        caught = err
        return err instanceof TransferError && err.code === "io"
      },
    )
    assert.match(caught.detail ?? "", /\.bak/, `io 错误详情必须给出备份路径：${caught.detail}`)
    assert.equal(sftp.node("dest.txt"), undefined, "回滚失败时原路径为空（错误已明确给出备份路径）")
    const backupPath = [...sftp.nodes.keys()].find((p) => p.endsWith(".bak"))
    assert.ok(backupPath, "回滚失败时旧目标应保留在 .bak 备份路径")
    assert.equal(sftp.node(backupPath).data.toString(), "old", "备份内容必须是旧目标内容")
    assert.deepEqual([...sftp.nodes.keys()].filter((p) => p.endsWith(".part")), [], "临时文件应被清理")
  })
})

test("无 overwrite 上传超时：不 rename，且尽力清理目标名下可能残留的半截文件", async () => {
  await withTempDir(async (dir) => {
    const local = join(dir, "a.txt")
    await writeFile(local, "payload")
    const sftp = new FakeSftp()
    sftp.hangWrite = true

    await assert.rejects(
      () => uploadFile({ sftp, localPath: local, remotePath: "x.txt", timeoutMs: 50 }),
      (err) => err instanceof TransferError && err.code === "timeout",
    )
    assert.equal(sftp.renameCalls.length, 0, "超时后不得 rename/commit")
    assert.equal(sftp.destroyed, true, "超时应中止 SFTP 通道")
    assert.equal(sftp.node("x.txt"), undefined, "通道可用时应清理目标名下的半截文件")
  })
})

test("无 overwrite 上传：预检后目标被抢建 → exists，且原目标内容不变", async () => {
  await withTempDir(async (dir) => {
    const local = join(dir, "a.txt")
    await writeFile(local, "new")
    const sftp = new FakeSftp()
    // 预检通过后、独占写流打开前，另一个写入者抢先创建目标
    sftp.beforeWriteStream = (np, flags) => {
      if (flags.includes("x") && np === "/x.txt" && !sftp.node("x.txt")) sftp.setFile("x.txt", "intruder")
    }

    await assert.rejects(
      () => uploadFile({ sftp, localPath: local, remotePath: "x.txt" }),
      (err) => err instanceof TransferError && err.code === "exists",
    )
    assert.equal(sftp.writeCalls.length, 1, "只应尝试一次独占创建")
    assert.equal(sftp.node("x.txt").data.toString(), "intruder", "竞态写入的内容不得被覆盖")
  })
})

/** 构造已"连接"的 SshSession，注入假 client（sftp 工厂）用于串行队列测试 */
function stubSshSession(sftpFactory) {
  const session = new SshSession("sid-stub", { dispose() {} }, "default", "en", 5000)
  session._connected = true
  session._lastActive = Date.now()
  session._client = { sftp: (cb) => sftpFactory(cb) }
  return session
}

test("_withSftp：通道 error 不提前结算队列，下一个任务在前一个 job settle 后才开始", async () => {
  await withTempDir(async (dir) => {
    const localA = join(dir, "a.txt")
    const localB = join(dir, "b.txt")
    await writeFile(localA, "aaa")
    await writeFile(localB, "bbb")

    const first = new FakeSftp()
    first.hangWrite = true
    // 让 job 在通道 error 后的清理阶段多花 300ms，用于验证队列确实在等 job settle
    first.unlink = (p, cb) => {
      setTimeout(() => cb(Object.assign(new Error("No such file"), { code: 2 })), 300)
    }
    const second = new FakeSftp()
    const queue = [first, second]
    const session = stubSshSession((cb) => cb(undefined, queue.shift()))

    const p1 = session.uploadFile({ localPath: localA, remotePath: "a.txt" })
    const p2 = session.uploadFile({ localPath: localB, remotePath: "b.txt" })

    await new Promise((r) => setTimeout(r, 100))
    assert.equal(second.writeCalls.length, 0, "前一个 job 未 settle 前，下一个传输不得开始")

    const abortedAt = Date.now()
    first.emit("error", new Error("channel boom"))
    await assert.rejects(
      () => p1,
      (err) => err instanceof TransferError && err.code === "io",
    )
    assert.ok(Date.now() - abortedAt >= 250, "通道 error 后必须等 job 真正 settle 再结算，不能立即放行下一个")
    const r2 = await p2
    assert.equal(second.writeCalls.length, 1, "前一个 job settle 后下一个任务才启动")
    assert.equal(r2.remotePath, "b.txt")
    assert.equal(second.node("b.txt").data.toString(), "bbb")
  })
})

test("_withSftp：开通道超时不拖死会话，后续队列任务照常执行", async () => {
  await withTempDir(async (dir) => {
    const local = join(dir, "a.txt")
    await writeFile(local, "x")
    const second = new FakeSftp()
    let call = 0
    const session = stubSshSession((cb) => {
      call += 1
      if (call === 1) return // 开通道回调永不返回
      cb(undefined, second)
    })

    const started = Date.now()
    await assert.rejects(
      () => session.uploadFile({ localPath: local, remotePath: "a.txt", timeoutMs: 50 }),
      (err) => err instanceof TransferError && err.code === "timeout",
    )
    assert.ok(Date.now() - started < 2_000, "开通道超时必须及时结算")

    const r2 = await session.uploadFile({ localPath: local, remotePath: "b.txt", timeoutMs: 2_000 })
    assert.equal(r2.remotePath, "b.txt")
    assert.equal(second.node("b.txt").data.toString(), "x", "后续任务应正常完成")
  })
})

test("LocalSession 拒绝文件传输（ssh_only，能力断言）", () => {
  const local = new LocalSession("sid", { dispose() {} }, "default", "en", 5000)
  assert.throws(
    () => assertTransferCapable(local),
    (err) => err instanceof TransferError && err.code === "ssh_only",
  )
})

test("upload onProgress：先回调 (0,size)，随后字节单调递增且 total 正确", async () => {
  await withTempDir(async (dir) => {
    const local = join(dir, "progress.txt")
    const content = "hello-progress"
    await writeFile(local, content)
    const sftp = new FakeSftp()
    const events = []
    const result = await uploadFile({
      sftp,
      localPath: local,
      remotePath: "progress.txt",
      onProgress: (bytes, total) => events.push([bytes, total]),
    })
    assert.equal(result.bytes, Buffer.byteLength(content))
    assert.deepEqual(events[0], [0, Buffer.byteLength(content)], "拿到 localStat 后先回调 (0,size)")
    assert.equal(events.at(-1)[0], Buffer.byteLength(content), "最终进度等于实际字节")
    for (const [, total] of events) assert.equal(total, Buffer.byteLength(content), "total 始终为文件大小")
    for (let i = 1; i < events.length; i++) assert.ok(events[i][0] >= events[i - 1][0], "bytes 必须单调不减")
  })
})

test("download onProgress：二进制文件字节单调、total 正确", async () => {
  await withTempDir(async (dir) => {
    const binary = Buffer.from([0, 1, 2, 255, 254, 10, 13, 0, 128])
    const sftp = new FakeSftp()
    sftp.setFile("bin.dat", binary)
    const local = join(dir, "bin.dat")
    const events = []
    const result = await downloadFile({
      sftp,
      remotePath: "bin.dat",
      localPath: local,
      onProgress: (bytes, total) => events.push([bytes, total]),
    })
    assert.equal(result.bytes, binary.length)
    assert.deepEqual(await readFile(local), binary, "二进制内容必须完整")
    assert.deepEqual(events[0], [0, binary.length])
    assert.equal(events.at(-1)[0], binary.length)
    for (const [, total] of events) assert.equal(total, binary.length)
    for (let i = 1; i < events.length; i++) assert.ok(events[i][0] >= events[i - 1][0])
  })
})

test("onProgress：空文件也有 (0,0) 回调", async () => {
  await withTempDir(async (dir) => {
    const local = join(dir, "empty.txt")
    await writeFile(local, "")
    const sftp = new FakeSftp()
    const events = []
    const result = await uploadFile({ sftp, localPath: local, remotePath: "empty.txt", onProgress: (b, t) => events.push([b, t]) })
    assert.equal(result.bytes, 0)
    assert.deepEqual(events, [[0, 0]], "空文件无数据块，只应有初始 (0,0) 回调")
  })
})

test("onProgress：回调抛错不得中断传输", async () => {
  await withTempDir(async (dir) => {
    const local = join(dir, "throw.txt")
    await writeFile(local, "still-transfers")
    const sftp = new FakeSftp()
    const result = await uploadFile({
      sftp,
      localPath: local,
      remotePath: "throw.txt",
      onProgress: () => { throw new Error("progress callback boom") },
    })
    assert.equal(result.bytes, Buffer.byteLength("still-transfers"))
    assert.equal(sftp.node("throw.txt").data.toString(), "still-transfers")
  })
})
