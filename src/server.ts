/**
 * OpenCode V2 server-side entrypoint.
 *
 * V2 resolves `./server` before the package root, so this file keeps the
 * server process off OpenTUI. V1's installer treats that same export as a
 * server plugin and rejects a module with no `server()`, so the empty hook
 * map is what the 1.x loader calls. V2 calls `setup()` and ignores `server`.
 */
export default {
  id: "opencode-token-metrics",
  setup() {},
  server() {
    return {}
  },
}
