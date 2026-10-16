/**
 * OpenCode V1 event adapter. Translates the V1 TUI event bus into the
 * platform-agnostic `MeterEvent`s consumed by `controller.ts`, so the
 * measurement core stays free of version-specific imports.
 */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { MeterController, MeterEvent } from "./controller.ts"
import { cacheHitRate } from "./meter.ts"

/** Delta fields that represent generated output. Everything else is ignored. */
const COUNTED_FIELDS = new Set(["text", "reasoning"])

/** The slice of the V1 plugin API the meter needs. */
export type V1MeterApi = Pick<TuiPluginApi, "event" | "state">

/**
 * Wire V1 events into the controller. Returns an unsubscribe function; the
 * caller decides when to dispose (V1 exposes `api.lifecycle.onDispose`).
 */
export function wireV1(api: V1MeterApi, controller: MeterController, onChange: () => void): () => void {
  const offDelta = api.event.on("message.part.delta", (event) => {
    const { sessionID, messageID, field, delta } = event.properties
    if (!sessionID || !delta) return
    if (!COUNTED_FIELDS.has(field)) return
    if (api.state.session.status(sessionID)?.type === "idle") return
    if (controller.handle({ kind: "delta", sessionID, messageID, text: delta, at: Date.now() })) onChange()
  })

  const offUpdated = api.event.on("message.updated", (event) => {
    const info = event.properties.info
    if (info.role !== "assistant") return
    if (info.time.completed) {
      // Cache fields are provider-dependent: an older or partial report may
      // omit `input` or `cache` entirely, so read them defensively.
      const { output, reasoning, input, cache } = info.tokens
      const done: MeterEvent = {
        kind: "done",
        sessionID: info.sessionID,
        at: Date.now(),
        exactTokens: output + reasoning,
        cache: cacheHitRate(input ?? 0, cache?.read ?? 0, cache?.write ?? 0),
      }
      if (controller.handle(done)) onChange()
      return
    }
    if (controller.handle({ kind: "turn", sessionID: info.sessionID, messageID: info.id, at: info.time.created })) {
      onChange()
    }
  })

  const offPart = api.event.on("message.part.updated", (event) => {
    if (event.properties.part.type !== "tool") return
    if (controller.handle({ kind: "segment", sessionID: event.properties.sessionID })) onChange()
  })

  const offDeleted = api.event.on("session.deleted", (event) => {
    if (controller.handle({ kind: "drop", sessionID: event.properties.sessionID })) onChange()
  })

  return () => {
    offDelta()
    offUpdated()
    offPart()
    offDeleted()
  }
}
