/**
 * Release smoke test: pack the package the way npm would, then verify the
 * tarball is self-consistent and loadable.
 *
 * Checks:
 *   - required files are present in the tarball
 *   - every `exports` target resolves to a file in the tarball
 *   - `oc-plugin` declares the tui target
 *   - the packed pure module can be imported
 *   - the packed TUI entry bundles (JSX + externals) without error
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const REQUIRED_FILES = [
  "package.json",
  "README.md",
  "LICENSE",
  "src/tui.tsx",
  "src/server.ts",
  "src/controller.ts",
  "src/v1.ts",
  "src/v2.ts",
  "src/meter.ts",
]

function fail(message) {
  console.error(`smoke: ${message}`)
  process.exit(1)
}

const temp = mkdtempSync(join(tmpdir(), "opencode-token-metrics-smoke-"))

// Run npm through its JS entrypoint when available: on Windows `npm` is
// `npm.cmd`, which cannot be spawned directly (and would need an unsafe shell).
const npmCli = process.env.npm_execpath
const runNpm = (args, options) =>
  npmCli
    ? execFileSync(process.execPath, [npmCli, ...args], options)
    : execFileSync("npm", args, options)

try {
  const raw = runNpm(["pack", "--json", "--pack-destination", temp], {
    cwd: process.cwd(),
    encoding: "utf8",
  })
  const [info] = JSON.parse(raw)
  const files = info.files.map((entry) => entry.path)

  const missing = REQUIRED_FILES.filter((file) => !files.includes(file))
  if (missing.length > 0) fail(`tarball is missing: ${missing.join(", ")}`)

  execFileSync("tar", ["xzf", join(temp, info.filename), "-C", temp])
  const extracted = join(temp, "package")
  const pkg = JSON.parse(readFileSync(join(extracted, "package.json"), "utf8"))

  for (const [key, value] of Object.entries(pkg.exports ?? {})) {
    const target = typeof value === "string" ? value : value?.import
    if (!target || !existsSync(join(extracted, target))) fail(`export "${key}" -> "${target}" does not resolve`)
  }

  if (!Array.isArray(pkg["oc-plugin"]) || !pkg["oc-plugin"].includes("tui")) {
    fail('package.json "oc-plugin" must include "tui"')
  }

  // `import()` needs a file URL; a bare Windows path is not a valid specifier.
  const meter = await import(pathToFileURL(join(extracted, "src", "meter.ts")).href)
  if (typeof meter.formatLine !== "function" || typeof meter.TpsMeter !== "function") {
    fail("packed src/meter.ts did not export the expected API")
  }

  const esbuild = await import("esbuild")
  try {
    await esbuild.build({
      entryPoints: [join(extracted, "src", "tui.tsx")],
      bundle: true,
      write: false,
      format: "esm",
      platform: "node",
      jsx: "automatic",
      jsxImportSource: "@opentui/solid",
      external: ["@opencode-ai/*", "@opencode/*", "@opentui/*", "solid-js"],
    })
  } catch (error) {
    fail(`entry failed to bundle: ${error instanceof Error ? error.message : String(error)}`)
  }

  console.log(`smoke: OK (${files.length} files, ${info.filename})`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
