/**
 * OpenCode V2 event adapter. Translates `session.*` events from
 * `ctx.data.on(...)` into the platform-agnostic `MeterEvent`s consumed by
 * `controller.ts`.
 *
 * Mapping (V2 has no single "message completed" event, so a turn is bracketed
 * by the step/execution lifecycle):
 *   session.step.started        -> turn    (first step of an execution only; later steps keep the graph)
 *   session.text/reasoning.delta-> delta   (streamed output)
 *   session.tool.called         -> segment (tool pause; the graph stays continuous)
 *   session.step.ended/failed   ->         (accumulate exact provider tokens)
 *   session.execution.*         -> done    (finish the turn with the summed tokens)
 *   session.compaction.started  -> turn    (compaction is its own generation)
 *   session.compaction.delta    -> delta   (streamed summary)
 *   session.compaction.ended    -> done    (finish with the reported tokens)
 *   session.compaction.failed   -> done    (finish on the estimate)
 *   session.deleted             -> drop    (forget the session)
 */
import type { Context } from "@opencode/plugin/tui/context"
import type { MeterController, MeterEvent } from "./controller.ts"
import { cacheHitRate } from "./meter.ts"

/** The slice of a step's provider-reported usage the meter consumes. */
type StepTokens = {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cache: { readonly read: number; readonly write: number }
}

/** Running provider-reported usage for one session's execution. */
type Usage = { output: number; input: number; cacheRead: number; cacheWrite: number }

/**
 * Wire V2 session events into the controller. Returns an unsubscribe function
 * that `setup` hands back to OpenCode for disposal.
 */
export function wireV2(ctx: Context, controller: MeterController, onChange: () => void): () => void {
  const exact = new Map<string, Usage>()
  const compacting = new Set<string>()
  // Sessions whose current execution already opened a meter turn. A tool loop
  // emits a new assistant message per step; opening again would wipe the graph.
  const opened = new Set<string>()
  const offs: Array<() => void> = []

  const emit = (event: MeterEvent) => {
    if (controller.handle(event)) onChange()
  }

  // A step's provider-reported usage; several steps can share one execution,
  // so totals are summed and settled when the execution ends.
  const addUsage = (sessionID: string, tokens: StepTokens | undefined) => {
    if (!tokens) return
    const usage = exact.get(sessionID) ?? { output: 0, input: 0, cacheRead: 0, cacheWrite: 0 }
    usage.output += tokens.output + tokens.reasoning
    usage.input += tokens.input
    usage.cacheRead += tokens.cache.read
    usage.cacheWrite += tokens.cache.write
    exact.set(sessionID, usage)
  }

  /** Turn accumulated usage into a settle payload, or an empty one. */
  const settleWith = (sessionID: string, usage: Usage | undefined): MeterEvent => {
    if (!usage) return { kind: "done", sessionID, at: Date.now() }
    return {
      kind: "done",
      sessionID,
      at: Date.now(),
      exactTokens: usage.output > 0 ? usage.output : undefined,
      cache: cacheHitRate(usage.input, usage.cacheRead, usage.cacheWrite),
    }
  }

  const finish = (sessionID: string) => {
    opened.delete(sessionID)
    // A compaction in flight owns the session's meter. Settling here would
    // rescale the graph twice, but this execution's totals must not be added
    // onto the next turn.
    if (compacting.has(sessionID)) {
      exact.delete(sessionID)
      return
    }
    const usage = exact.get(sessionID)
    exact.delete(sessionID)
    emit(settleWith(sessionID, usage))
  }

  offs.push(
    ctx.data.on("session.step.started", (event) => {
      const sessionID = event.data.sessionID
      if (opened.has(sessionID)) return
      opened.add(sessionID)
      emit({
        kind: "turn",
        sessionID,
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

  offs.push(
    ctx.data.on("session.execution.succeeded", (event) => finish(event.data.sessionID)),
  )
  offs.push(ctx.data.on("session.execution.failed", (event) => finish(event.data.sessionID)))
  offs.push(ctx.data.on("session.execution.interrupted", (event) => finish(event.data.sessionID)))

  // Compaction is a generation of its own: it streams a summary and reports its
  // own token usage, but never emits the step/execution events above.
  offs.push(
    ctx.data.on("session.compaction.started", (event) => {
      const sessionID = event.data.sessionID
      compacting.add(sessionID)
      opened.delete(sessionID)
      exact.delete(sessionID)
      emit({
        kind: "turn",
        sessionID,
        // The event carries no timestamp, so the arrival time starts the TTFT window.
        messageID: event.data.inputID ?? `compaction:${sessionID}`,
        at: Date.now(),
      })
    }),
  )

  const onCompactionDelta = (sessionID: string, text: string) => {
    if (!text) return
    emit({ kind: "delta", sessionID, text, at: Date.now() })
  }
  offs.push(ctx.data.on("session.compaction.delta", (event) => onCompactionDelta(event.data.sessionID, event.data.text)))

  const finishCompaction = (sessionID: string, tokens: StepTokens | undefined) => {
    compacting.delete(sessionID)
    opened.delete(sessionID)
    exact.delete(sessionID)
    emit(
      settleWith(
        sessionID,
        tokens
          ? { output: tokens.output + tokens.reasoning, input: tokens.input, cacheRead: tokens.cache.read, cacheWrite: tokens.cache.write }
          : undefined,
      ),
    )
  }
  offs.push(ctx.data.on("session.compaction.ended", (event) => finishCompaction(event.data.sessionID, event.data.tokens)))
  offs.push(ctx.data.on("session.compaction.failed", (event) => finishCompaction(event.data.sessionID, event.data.tokens)))

  offs.push(
    ctx.data.on("session.deleted", (event) => {
      exact.delete(event.data.sessionID)
      compacting.delete(event.data.sessionID)
      opened.delete(event.data.sessionID)
      emit({ kind: "drop", sessionID: event.data.sessionID })
    }),
  )

  return () => {
    for (const off of offs) off()
  }
}
