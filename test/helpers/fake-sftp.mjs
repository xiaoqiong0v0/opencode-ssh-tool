// fake SFTP：单测用最小实现（只覆盖 transfer.ts 用到的接口）
import { EventEmitter } from "node:events"
import { Readable, Writable } from "node:stream"
import { posix } from "node:path"

/** SFTP 状态码 2 = NO_SUCH_FILE（与 ssh2 一致） */
export function enoent() {
  const err = new Error("No such file")
  err.code = 2
  return err
}

/** 模拟"已存在"（EXCL 冲突 / 本地 EEXIST） */
export function existsError() {
  const err = new Error("Failure")
  err.code = 4
  return err
}

/** 构造最小 Stats（transfer.ts 只用 size/isFile/isDirectory/isSymbolicLink） */
export function statsOf(node) {
  return {
    size: node.type === "file" ? node.data.length : 0,
    mode: 0,
    uid: 0,
    gid: 0,
    atime: 0,
    mtime: 0,
    isFile: () => node.type === "file",
    isDirectory: () => node.type === "dir",
    isSymbolicLink: () => node.type === "symlink",
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  }
}

/** 最小 fake SFTP：远端路径统一按 POSIX 归一（相对路径映射到根下同名绝对路径） */
export class FakeSftp extends EventEmitter {
  constructor(home = "/home/tester") {
    super()
    this.home = home
    this.nodes = new Map()
    this.events = []
    this.writeCalls = []
    this.readCalls = []
    this.mkdirCalls = []
    this.renameCalls = []
    this.unlinkCalls = []
    this.endCalled = false
    this.destroyed = false
    this.failWrite = null
    this.failRead = null
    this.hangWrite = false
    this.hangRead = false
    this.hangRealpath = false
    /** 模拟 ssh2 SFTP WriteStream：成功只 emit close，不 emit finish */
    this.closeOnlyWrite = false
    /** open 后立即 destroy 写流（模拟服务端提前 close / 短写回归） */
    this.closeEarlyWrite = false
    /** (src, dst, callIndex) => boolean；返回 true 表示该次 rename 失败 */
    this.failRename = null
    /** (normalizedPath, flags) => void；在独占创建判定之前调用，用于模拟"预检后被抢建" */
    this.beforeWriteStream = null
    this.nodes.set("/", { type: "dir" })
    this.nodes.set(this.home, { type: "dir" })
  }

  norm(p) {
    const s = String(p).replace(/\\/g, "/")
    return posix.normalize(s.startsWith("/") ? s : `/${s}`)
  }

  node(p) {
    return this.nodes.get(this.norm(p))
  }

  setFile(p, data) {
    if (!this.parentExists(p)) throw new Error(`fake: parent missing for ${p}`)
    this.nodes.set(this.norm(p), { type: "file", data: Buffer.from(data) })
  }

  parentExists(p) {
    const dir = posix.dirname(this.norm(p))
    if (dir === "/" || /^\/[A-Za-z]:$/.test(dir)) return true
    const node = this.nodes.get(dir)
    return !!node && node.type === "dir"
  }

  stat(p, cb) {
    const node = this.node(p)
    if (!node) return cb(enoent())
    if (node.type === "symlink") {
      const target = this.node(node.target)
      if (!target) return cb(enoent())
      return cb(undefined, statsOf(target))
    }
    cb(undefined, statsOf(node))
  }

  lstat(p, cb) {
    const node = this.node(p)
    if (!node) return cb(enoent())
    cb(undefined, statsOf(node))
  }

  createReadStream(p) {
    this.readCalls.push({ path: this.norm(p) })
    const node = this.node(p)
    if (!node || node.type !== "file") {
      return new Readable({ read() { this.destroy(enoent()) } })
    }
    if (this.hangRead) return new Readable({ read() { /* 永不产出 */ } })
    const failure = this.failRead
    if (failure) {
      let sent = false
      return new Readable({
        read() {
          if (sent) return
          sent = true
          this.push(node.data.subarray(0, Math.max(1, node.data.length - 1)))
          this.destroy(failure)
        },
      })
    }
    return Readable.from([node.data])
  }

  createWriteStream(p, options = {}) {
    const np = this.norm(p)
    const flags = options.flags ?? "w"
    const fake = this
    this.writeCalls.push({ path: np, flags })
    if (this.beforeWriteStream) this.beforeWriteStream(np, flags)
    const chunks = []
    const pending = []
    let failed = false
    let opened = false
    const processWrite = (chunk, cb) => {
      if (failed) return cb()
      chunks.push(Buffer.from(chunk))
      if (fake.nodes.has(np)) fake.nodes.get(np).data = Buffer.concat(chunks)
      if (fake.failWrite) {
        failed = true
        return cb(fake.failWrite)
      }
      cb()
    }
    const sink = new Writable({
      write(chunk, _enc, cb) {
        if (!opened) {
          pending.push({ chunk: Buffer.from(chunk), cb })
          return
        }
        processWrite(chunk, cb)
      },
      final(cb) {
        if (failed || fake.hangWrite) return
        fake.nodes.set(np, { type: "file", data: Buffer.concat(chunks) })
        cb()
        // ssh2 不 emit finish；给 closeOnly 模式补一个成功 close
        if (fake.closeOnlyWrite) process.nextTick(() => sink.emit("close"))
      },
    })
    if (fake.closeOnlyWrite) {
      const emit = sink.emit.bind(sink)
      sink.emit = (event, ...args) => (event === "finish" ? false : emit(event, ...args))
    }
    const exists = fake.nodes.has(np)
    if (flags.includes("x") && exists) {
      failed = true
      process.nextTick(() => {
        sink.emit("error", existsError())
        sink.destroy()
      })
      return sink
    }
    if (!fake.parentExists(np)) {
      failed = true
      process.nextTick(() => {
        sink.emit("error", enoent())
        sink.destroy()
      })
      return sink
    }
    // 模拟 SSH_FXF_CREAT：open 成功即创建空文件（后续失败时用于验证清理）
    fake.nodes.set(np, { type: "file", data: Buffer.alloc(0) })
    if (!fake.hangWrite) {
      process.nextTick(() => {
        opened = true
        sink.emit("open", Buffer.from("h"))
        if (fake.closeEarlyWrite) {
          process.nextTick(() => sink.destroy())
          return
        }
        for (const item of pending.splice(0)) processWrite(item.chunk, item.cb)
      })
    }
    return sink
  }

  mkdir(p, cb) {
    this.mkdirCalls.push(p)
    const np = this.norm(p)
    if (this.nodes.has(np)) {
      const err = new Error("Failure")
      err.code = 4
      return cb(err)
    }
    if (!this.parentExists(np)) return cb(enoent())
    this.nodes.set(np, { type: "dir" })
    cb()
  }

  rename(src, dest, cb) {
    const s = this.norm(src)
    const d = this.norm(dest)
    this.renameCalls.push({ src: s, dest: d })
    if (this.failRename && this.failRename(s, d, this.renameCalls.length)) {
      return cb(existsError())
    }
    const node = this.nodes.get(s)
    if (!node) return cb(enoent())
    this.events.push(`rename:${s}->${d}`)
    this.nodes.set(d, node)
    this.nodes.delete(s)
    cb()
  }

  unlink(p, cb) {
    const np = this.norm(p)
    this.unlinkCalls.push(np)
    if (!this.nodes.has(np)) return cb(enoent())
    this.events.push(`unlink:${np}`)
    this.nodes.delete(np)
    cb()
  }

  realpath(p, cb) {
    if (this.hangRealpath) return
    if (p === "." || p === "~") return cb(undefined, this.home)
    cb(undefined, this.norm(p))
  }

  end() {
    this.endCalled = true
  }

  destroy() {
    this.destroyed = true
  }
}
