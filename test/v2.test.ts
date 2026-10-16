import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { Context } from "@opencode/plugin/tui/context"
import { createMeterController } from "../src/controller.ts"
import { wireV2 } from "../src/v2.ts"

type Handler = (event: unknown) => void

function harness() {
  const handlers = new Map<string, Handler>()
  let status: "idle" | "running" = "running"

  const ctx = {
    data: {
      on(type: string, handler: Handler) {
        handlers.set(type, handler)
        return () => {
          handlers.delete(type)
        }
      },
      session: { status: () => status },
    },
  } as unknown as Context

  return {
    ctx,
    handlers,
    emit: (type: string, event: unknown) => handlers.get(type)?.(event),
    setStatus: (next: "idle" | "running") => {
      status = next
    },
  }
}

const stepStarted = (sessionID: string, messageID: string, started: number) => ({
  data: { sessionID, assistantMessageID: messageID, agent: "a", model: { providerID: "p", modelID: "m" }, started },
})

const textDelta = (sessionID: string, delta: string, messageID = "m1") => ({
  data: { sessionID, assistantMessageID: messageID, ordinal: 0, delta },
})

const reasoningDelta = (sessionID: string, delta: string, messageID = "m1") => ({
  data: { sessionID, assistantMessageID: messageID, ordinal: 0, delta },
})

const toolCalled = (sessionID: string) => ({
  data: { sessionID, assistantMessageID: "m1", id: "t1", input: {}, executed: true },
})

const stepEnded = (sessionID: string, output: number, reasoning: number) => ({
  data: {
    sessionID,
    assistantMessageID: "m1",
    finish: "tool-calls",
    cost: 0,
    tokens: { input: 0, output, reasoning, cache: { read: 0, write: 0 } },
  },
})

const executionSucceeded = (sessionID: string) => ({ data: { sessionID } })

const compactionStarted = (sessionID: string, inputID = "m0") => ({
  data: { sessionID, reason: "auto", recent: "…", inputID },
})

const compactionDelta = (sessionID: string, text: string) => ({ data: { sessionID, text } })

const compactionEnded = (sessionID: string, output: number, reasoning: number) => ({
  data: { sessionID, reason: "auto", text: "summary", recent: "…", tokens: { input: 0, output, reasoning, cache: { read: 0, write: 0 } } },
})

const CONFIG = { rollingWindowMs: 5000, idleTimeoutMs: 1500, minSpanMs: 300 }

describe("wireV2", () => {
  it("records text deltas for running sessions", () => {
    const h = harness()
    let updates = 0
    const controller = createMeterController(CONFIG)
    wireV2(h.ctx, controller, () => {
      updates += 1
    })

    h.emit("session.text.delta", textDelta("s1", "abcdefgh"))
    assert.equal(controller.store.snapshot("s1", Date.now(), 4)?.tokens, 2)
    assert.equal(updates, 1)
  })

  it("counts reasoning deltas too", () => {
    const h = harness()
    const controller = createMeterController(CONFIG)
    wireV2(h.ctx, controller, () => {})
    h.emit("session.reasoning.delta", reasoningDelta("s1", "abcdefgh"))
    assert.equal(controller.store.snapshot("s1", Date.now(), 4)?.tokens, 2)
  })

  it("ignores deltas while the session is idle", () => {
    const h = harness()
    h.setStatus("idle")
    const controller = createMeterController(CONFIG)
    wireV2(h.ctx, controller, () => {})
    h.emit("session.text.delta", textDelta("s1", "abcdefgh"))
    assert.equal(controller.store.snapshot("s1", Date.now(), 4), undefined)
  })

  it("starts a turn on step start to measure TTFT", () => {
    const h = harness()
    const controller = createMeterController(CONFIG)
    wireV2(h.ctx, controller, () => {})
    h.emit("session.step.started", stepStarted("s1", "m1", Date.now() - 500))
    h.emit("session.text.delta", textDelta("s1", "abcdefgh"))
    const ttft = controller.store.snapshot("s1", Date.now(), 4)?.ttftMs
    assert.ok(ttft !== undefined)
    assert.ok((ttft ?? 0) > 0)
  })

  it("starts a new segment when a tool is called", () => {
    const h = harness()
    let updates = 0
    const controller = createMeterController(CONFIG)
    wireV2(h.ctx, controller, () => {
      updates += 1
    })
    h.emit("session.text.delta", textDelta("s1", "abcdefgh"))
    h.emit("session.tool.called", toolCalled("s1"))
    const snapshot = controller.store.snapshot("s1", Date.now(), 4)
    assert.equal(snapshot?.tokens, 2)
    assert.equal(snapshot?.rate, -1)
    assert.ok(updates >= 2)
  })

  it("settles with the summed step tokens when the execution ends", () => {
    const h = harness()
    const controller = createMeterController(CONFIG)
    wireV2(h.ctx, controller, () => {})
    h.emit("session.text.delta", textDelta("s1", "abcdefgh"))
    h.emit("session.step.ended", stepEnded("s1", 100, 20))
    h.emit("session.step.ended", stepEnded("s1", 30, 0))
    h.emit("session.execution.succeeded", executionSucceeded("s1"))
    const snapshot = controller.store.snapshot("s1", Date.now(), 4)
    assert.equal(snapshot?.settled, true)
    assert.equal(snapshot?.tokens, 150)
  })

  it("settles on the estimate when no exact tokens were reported", () => {
    const h = harness()
    const controller = createMeterController(CONFIG)
    wireV2(h.ctx, controller, () => {})
    h.emit("session.text.delta", textDelta("s1", "abcdefgh"))
    h.emit("session.execution.succeeded", executionSucceeded("s1"))
    const snapshot = controller.store.snapshot("s1", Date.now(), 4)
    assert.equal(snapshot?.settled, true)
    assert.equal(snapshot?.tokens, 2)
  })

  it("forgets a session when it is deleted", () => {
    const h = harness()
    const controller = createMeterController(CONFIG)
    wireV2(h.ctx, controller, () => {})
    h.emit("session.text.delta", textDelta("s1", "abcdefgh"))
    assert.equal(controller.store.size, 1)
    h.emit("session.deleted", { data: { sessionID: "s1" } })
    assert.equal(controller.store.size, 0)
    assert.equal(controller.store.snapshot("s1", Date.now(), 4), undefined)
  })

  it("counts compaction as its own generation", () => {
    const h = harness()
    let updates = 0
    const controller = createMeterController(CONFIG)
    wireV2(h.ctx, controller, () => {
      updates += 1
    })

    h.emit("session.compaction.started", compactionStarted("s1"))
    h.emit("session.compaction.delta", compactionDelta("s1", "abcdefgh"))
    assert.equal(controller.store.snapshot("s1", Date.now(), 4)?.tokens, 2)

    h.emit("session.compaction.ended", compactionEnded("s1", 400, 50))
    const snapshot = controller.store.snapshot("s1", Date.now(), 4)
    assert.equal(snapshot?.settled, true)
    assert.equal(snapshot?.tokens, 450)
    assert.ok(updates >= 3)
  })

  it("measures compaction TTFT from the event arrival", () => {
    const h = harness()
    const controller = createMeterController(CONFIG)
    wireV2(h.ctx, controller, () => {})
    h.emit("session.compaction.started", compactionStarted("s1"))
    h.emit("session.compaction.delta", compactionDelta("s1", "abcdefgh"))
    const ttft = controller.store.snapshot("s1", Date.now(), 4)?.ttftMs
    assert.ok(ttft !== undefined)
    assert.ok((ttft ?? 0) >= 0)
  })

  it("settles a failed compaction on the estimate", () => {
    const h = harness()
    const controller = createMeterController(CONFIG)
    wireV2(h.ctx, controller, () => {})
    h.emit("session.compaction.started", compactionStarted("s1"))
    h.emit("session.compaction.delta", compactionDelta("s1", "abcdefgh"))
    h.emit("session.compaction.failed", { data: { sessionID: "s1", reason: "auto", error: { type: "e", message: "m" } } })
    const snapshot = controller.store.snapshot("s1", Date.now(), 4)
    assert.equal(snapshot?.settled, true)
    assert.equal(snapshot?.tokens, 2)
  })

  it("lets an execution settle once its compaction has finished", () => {
    const h = harness()
    const controller = createMeterController(CONFIG)
    wireV2(h.ctx, controller, () => {})
    h.emit("session.compaction.started", compactionStarted("s1"))
    h.emit("session.compaction.ended", compactionEnded("s1", 400, 50))
    h.emit("session.text.delta", textDelta("s1", "abcdefgh"))
    h.emit("session.step.ended", stepEnded("s1", 100, 20))
    h.emit("session.execution.succeeded", executionSucceeded("s1"))
    assert.equal(controller.store.snapshot("s1", Date.now(), 4)?.tokens, 120)
  })

  it("ignores an execution that lands mid-compaction", () => {
    const h = harness()
    const controller = createMeterController(CONFIG)
    wireV2(h.ctx, controller, () => {})
    h.emit("session.compaction.started", compactionStarted("s1"))
    h.emit("session.compaction.delta", compactionDelta("s1", "abcdefgh"))
    h.emit("session.execution.succeeded", executionSucceeded("s1"))
    assert.equal(controller.store.snapshot("s1", Date.now(), 4)?.settled, false)

    h.emit("session.compaction.ended", compactionEnded("s1", 400, 50))
    assert.equal(controller.store.snapshot("s1", Date.now(), 4)?.tokens, 450)
  })

  it("unsubscribes on dispose", () => {
    const h = harness()
    const controller = createMeterController(CONFIG)
    const dispose = wireV2(h.ctx, controller, () => {})
    assert.equal(h.handlers.size, 14)
    dispose()
    assert.equal(h.handlers.size, 0)
  })
})
