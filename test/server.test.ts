import assert from "node:assert/strict"
import { describe, it } from "node:test"
import plugin from "../src/server.ts"

describe("server entry", () => {
  it("loads under both the V1 server() check and the V2 setup() check", () => {
    assert.equal(plugin.id, "opencode-token-metrics")
    assert.equal(typeof plugin.setup, "function")
    assert.equal(typeof plugin.server, "function")
    assert.deepEqual(plugin.server(), {})
  })
})
