/**
 * OpenCode V2 event adapter. Translates `session.*` events from
 * `ctx.data.on(...)` into the platform-agnostic `MeterEvent`s consumed by
 * `controller.ts`.
 *
 * Mapping (V2 has no single "message completed" event, so a turn is bracketed
 * by the step/execution lifecycle):
 *   session.step.started        -> turn    (opens the assistant turn, incl. TTFT start)
 *   session.text/reasoning.delta-> delta   (streamed output)
 *   session.tool.called         -> segment (tool pause; the graph stays continuous)
 *   session.step.ended/failed   ->         (accumulate exact provider tokens)
 *   session.execution.*         -> done    (finish the turn with the summed tokens)
 *   session.deleted             -> drop    (forget the session)
 */
import type { Context } from "@opencode/plugin/tui/context"
import type { MeterController, MeterEvent } from "./controller.ts"

/** The subset of a step's token usage that counts as generated output. */
type StepTokens = { readonly output: number; readonly reasoning: number }

/**
 * Wire V2 session events into the controller. Returns an unsubscribe function
 * that `setup` hands back to OpenCode for disposal.
 */
export function wireV2(ctx: Context, controller: MeterController, onChange: () => void): () => void {
  const exact = new Map<string, number>()
  const offs: Array<() => void> = []

  const emit = (event: MeterEvent) => {
    if (controller.handle(event)) onChange()
  }

  // A step's provider-reported usage; several steps can share one execution,
  // so totals are summed and settled when the execution ends.
  const addUsage = (sessionID: string, tokens: StepTokens | undefined) => {
    if (!tokens) return
    exact.set(sessionID, (exact.get(sessionID) ?? 0) + tokens.output + tokens.reasoning)
  }

  const finish = (sessionID: string) => {
    const total = exact.get(sessionID)
    exact.delete(sessionID)
    emit({ kind: "done", sessionID, at: Date.now(), exactTokens: total && total > 0 ? total : undefined })
  }

  offs.push(
    ctx.data.on("session.step.started", (event) => {
      emit({
        kind: "turn",
        sessionID: event.data.sessionID,
        messageID: event.data.assistantMessageID,
        at: event.data.started,
      })
    }),
  )

  const onDelta = (sessionID: string, delta: string) => {
    if (!delta) return
    if (ctx.data.session.status(sessionID) === "idle") return
    emit({ kind: "delta", sessionID, text: delta, at: Date.now() })
  }
  offs.push(ctx.data.on("session.text.delta", (event) => onDelta(event.data.sessionID, event.data.delta)))
  offs.push(ctx.data.on("session.reasoning.delta", (event) => onDelta(event.data.sessionID, event.data.delta)))

  offs.push(
    ctx.data.on("session.tool.called", (event) => {
      emit({ kind: "segment", sessionID: event.data.sessionID })
    }),
  )

  offs.push(ctx.data.on("session.step.ended", (event) => addUsage(event.data.sessionID, event.data.tokens)))
  offs.push(ctx.data.on("session.step.failed", (event) => addUsage(event.data.sessionID, event.data.tokens)))

  offs.push(ctx.data.on("session.execution.succeeded", (event) => finish(event.data.sessionID)))
  offs.push(ctx.data.on("session.execution.failed", (event) => finish(event.data.sessionID)))
  offs.push(ctx.data.on("session.execution.interrupted", (event) => finish(event.data.sessionID)))

  offs.push(
    ctx.data.on("session.deleted", (event) => {
      exact.delete(event.data.sessionID)
      emit({ kind: "drop", sessionID: event.data.sessionID })
    }),
  )

  return () => {
    for (const off of offs) off()
  }
}
