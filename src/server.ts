/**
 * OpenCode V2 server-side entrypoint.
 *
 * This plugin only renders in the terminal, and the V2 TUI loads `./tui` for
 * that. The server entry exists so the package is a valid V2 plugin without
 * pulling OpenTUI into the server runtime: `@opencode/plugin` resolves the
 * server entry first, so this stub is preferred over any TUI code.
 */
export default {
  id: "opencode-token-metrics",
  setup() {},
}
