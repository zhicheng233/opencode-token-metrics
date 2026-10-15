/**
 * Platform-agnostic meter controller. Version-specific adapters (`v1.ts` for
 * OpenCode V1, `v2.ts` for OpenCode V2) translate their event buses into
 * normalized `MeterEvent`s and feed them here. Kept free of TUI and plugin
 * imports so it can be exercised with plain objects in tests.
 */
import { MeterStore, type RateConfig } from "./meter.ts"

/** A normalized input to the meter, independent of OpenCode's event shape. */
export type MeterEvent =
  | { kind: "turn"; sessionID: string; messageID: string; at: number }
  | { kind: "delta"; sessionID: string; messageID?: string; text: string; at: number }
  | { kind: "segment"; sessionID: string }
  | { kind: "done"; sessionID: string; at: number; exactTokens?: number }
  | { kind: "drop"; sessionID: string }

export type MeterController = {
  store: MeterStore
  /** Apply one event. Returns whether it changed meter state. */
  handle: (event: MeterEvent) => boolean
  tick: (now?: number) => void
}

export function createMeterController(config: RateConfig): MeterController {
  const store = new MeterStore(config)

  const handle = (event: MeterEvent): boolean => {
    switch (event.kind) {
      case "turn":
        store.beginTurn(event.sessionID, event.messageID, event.at)
        return true
      case "delta":
        store.record(event.sessionID, event.text, event.at, event.messageID)
        return true
      case "segment":
        return store.newSegment(event.sessionID)
      case "done":
        return store.settle(event.sessionID, event.exactTokens, event.at)
      case "drop":
        return store.drop(event.sessionID)
    }
  }

  return {
    store,
    handle,
    tick: (now: number = Date.now()) => store.prune(now),
  }
}
