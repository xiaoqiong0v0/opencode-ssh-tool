import { build } from "esbuild"
import { copyFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const src = join(root, "web", "src")
const out = join(root, "dist", "web")

mkdirSync(join(out, "fonts"), { recursive: true })

await build({
  entryPoints: [join(src, "main.ts")],
  bundle: true,
  outfile: join(out, "app.js"),
  format: "iife",
  target: "es2020",
  minify: true,
  logLevel: "warning",
})

// CSS 直接复制（字体 url 为 /web/fonts/... 运行时路径，不经 esbuild 解析/改写）
copyFileSync(join(src, "style.css"), join(out, "app.css"))

copyFileSync(join(src, "index.html"), join(out, "index.html"))
copyFileSync(
  join(root, "web", "assets", "fonts", "CaskaydiaCoveNerdFontMono-Regular.ttf"),
  join(out, "fonts", "CaskaydiaCoveNerdFontMono-Regular.ttf"),
)

console.log("web build ok ->", out)