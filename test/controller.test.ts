import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createMeterController } from "../src/controller.ts"

const CONFIG = { rollingWindowMs: 5000, idleTimeoutMs: 1500, minSpanMs: 300 }

describe("createMeterController", () => {
  it("records a delta and reports a change", () => {
    const controller = createMeterController(CONFIG)
    assert.equal(controller.handle({ kind: "delta", sessionID: "s1", text: "abcdefgh", at: 1000 }), true)
    assert.equal(controller.store.snapshot("s1", 1000, 4)?.tokens, 2)
  })

  it("opens a turn so time to first token can be measured", () => {
    const controller = createMeterController(CONFIG)
    controller.handle({ kind: "turn", sessionID: "s1", messageID: "m1", at: 1000 })
    controller.handle({ kind: "delta", sessionID: "s1", messageID: "m1", text: "abcdefgh", at: 1500 })
    assert.equal(controller.store.snapshot("s1", 1600, 4)?.ttftMs, 500)
  })

  it("settles with exact provider tokens", () => {
    const controller = createMeterController(CONFIG)
    controller.handle({ kind: "delta", sessionID: "s1", text: "abcdefgh", at: 1000 })
    assert.equal(controller.handle({ kind: "done", sessionID: "s1", at: 1100, exactTokens: 128 }), true)
    const snapshot = controller.store.snapshot("s1", 1100, 4)
    assert.equal(snapshot?.settled, true)
    assert.equal(snapshot?.tokens, 128)
  })

  it("restarts the live rate on a new segment", () => {
    const controller = createMeterController(CONFIG)
    controller.handle({ kind: "delta", sessionID: "s1", text: "abcdefgh", at: 1000 })
    assert.equal(controller.handle({ kind: "segment", sessionID: "s1" }), true)
    const snapshot = controller.store.snapshot("s1", 1000, 4)
    assert.equal(snapshot?.tokens, 2)
    assert.equal(snapshot?.rate, -1)
  })

  it("reports no change for unknown sessions", () => {
    const controller = createMeterController(CONFIG)
    assert.equal(controller.handle({ kind: "segment", sessionID: "missing" }), false)
    assert.equal(controller.handle({ kind: "done", sessionID: "missing", at: 0 }), false)
    assert.equal(controller.handle({ kind: "drop", sessionID: "missing" }), false)
  })

  it("forgets a session when dropped", () => {
    const controller = createMeterController(CONFIG)
    controller.handle({ kind: "delta", sessionID: "s1", text: "abcdefgh", at: 1000 })
    assert.equal(controller.handle({ kind: "drop", sessionID: "s1" }), true)
    assert.equal(controller.store.size, 0)
  })

  it("prunes old samples on tick but keeps the total", () => {
    const controller = createMeterController({ rollingWindowMs: 1000, idleTimeoutMs: 500, minSpanMs: 200 })
    controller.handle({ kind: "delta", sessionID: "s1", text: "abcdefgh", at: 0 })
    controller.tick(6000)
    assert.equal(controller.store.snapshot("s1", 6000, 4)?.tokens, 2)
  })
})
