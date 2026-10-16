/** @jsxImportSource @opentui/solid */
/**
 * TUI rendering layer for both OpenCode generations.
 *
 * The default export carries two shapes so one package serves V1 and V2:
 *   - V1 (`@opencode-ai/plugin/tui`) reads `tui`, registered via `tui.json`.
 *   - V2 (`@opencode/plugin/tui`) reads `id` + `setup`, registered via
 *     `plugins`; it renders into the `prompt.footer.status` slot.
 *
 * Both paths share `MeterLine` and the platform-agnostic controller; only the
 * event wiring (`v1.ts` / `v2.ts`) and theme lookup differ.
 */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import type { RGBA } from "@opentui/core"
import { Show, createMemo, createSignal } from "solid-js"
import { createMeterController, type MeterController } from "./controller.ts"
import { formatLine, hasData, rateTier, type Tier, type VuScale } from "./meter.ts"
import { wireV1 } from "./v1.ts"
import { wireV2 } from "./v2.ts"

export type TpsMeterOptions = {
  enabled?: boolean
  rollingWindowMs?: number
  idleTimeoutMs?: number
  minSpanMs?: number
  vuColumns?: number
  vuFullTps?: number
  vuScale?: VuScale
  slowTps?: number
  fastTps?: number
  showVu?: boolean
  showTrend?: boolean
  showAvg?: boolean
  showPeak?: boolean
  showTtft?: boolean
  showTokenCount?: boolean
  showElapsed?: boolean
  alwaysShow?: boolean
  idleText?: string
  label?: string
}

const DEFAULTS = {
  enabled: true,
  rollingWindowMs: 5000,
  idleTimeoutMs: 1500,
  minSpanMs: 300,
  vuColumns: 12,
  vuFullTps: 50,
  vuScale: "auto" as VuScale,
  slowTps: 10,
  fastTps: 30,
  showVu: true,
  showTrend: true,
  showAvg: true,
  showPeak: true,
  showTtft: true,
  showTokenCount: false,
  showElapsed: false,
  alwaysShow: false,
  idleText: "idle",
  label: "tok/s",
} satisfies Required<TpsMeterOptions>

type ResolvedOptions = typeof DEFAULTS

/** The four colors the meter renders with, resolved per generation. */
type Palette = { slow: RGBA; medium: RGBA; fast: RGBA; idle: RGBA }

function resolveOptions(raw: unknown): ResolvedOptions {
  return { ...DEFAULTS, ...((raw ?? {}) as Partial<ResolvedOptions>) }
}

/** V1 exposes flat semantic colors on the current theme. */
function v1Palette(theme: TuiThemeCurrent): Palette {
  return { slow: theme.error, medium: theme.warning, fast: theme.success, idle: theme.textMuted }
}

/** V2 exposes feedback colors and muted text on the resolved theme. */
function v2Palette(ctx: Context): Palette {
  const text = ctx.theme.text
  return {
    slow: text.feedback.error.base,
    medium: text.feedback.warning.base,
    fast: text.feedback.success.base,
    idle: text.muted,
  }
}

function tierColor(tier: Tier, palette: Palette): RGBA {
  switch (tier) {
    case "slow":
      return palette.slow
    case "medium":
      return palette.medium
    case "fast":
      return palette.fast
    default:
      return palette.idle
  }
}

/** One reactive meter line. Shared by both generations; only `palette` differs. */
function MeterLine(props: {
  sessionID: string
  store: MeterController["store"]
  rev: () => number
  beat: () => number
  options: ResolvedOptions
  palette: () => Palette
}) {
  const snapshot = createMemo(() => {
    props.rev()
    props.beat()
    return props.store.snapshot(props.sessionID, Date.now(), props.options.vuColumns)
  })

  const active = createMemo(() => hasData(snapshot()))

  const mounted = createMemo(() => active() || props.options.alwaysShow)

  const text = createMemo(() => {
    const state = snapshot()
    if (!active() || !state) {
      return props.options.alwaysShow ? `${props.options.label} ${props.options.idleText}` : ""
    }
    return formatLine(state, props.options)
  })

  const color = createMemo(() => {
    const state = snapshot()
    const palette = props.palette()
    if (!state) return palette.idle
    return tierColor(rateTier(state.rate, props.options.slowTps, props.options.fastTps), palette)
  })

  return (
    <Show when={mounted()}>
      <text fg={color()}>{text()}</text>
    </Show>
  )
}

/** V2: `Plugin.define({ id, setup })`. `setup` returns the disposer. */
function setupV2(ctx: Context): (() => void) | undefined {
  const options = resolveOptions(ctx.options)
  if (!options.enabled) return

  const [rev, setRev] = createSignal(0)
  const [beat, setBeat] = createSignal(0)
  const controller = createMeterController(options)
  const unwire = wireV2(ctx, controller, () => setRev((n) => n + 1))

  const timer = setInterval(() => {
    controller.tick()
    setBeat((n) => n + 1)
  }, 1000)

  const unclaim = ctx.ui.slot({
    append: "prompt.footer.status",
    render: (input) => (
      <Show when={input.sessionID}>
        {(sessionID) => (
          <MeterLine
            sessionID={sessionID()}
            store={controller.store}
            rev={rev}
            beat={beat}
            options={options}
            palette={() => v2Palette(ctx)}
          />
        )}
      </Show>
    ),
  })

  return () => {
    clearInterval(timer)
    unwire()
    unclaim()
  }
}

/** V1: `tui(api, options)`. Disposal goes through `api.lifecycle`. */
const tui: TuiPlugin = async (api, rawOptions) => {
  const options = resolveOptions(rawOptions)
  if (!options.enabled) return

  const [rev, setRev] = createSignal(0)
  const [beat, setBeat] = createSignal(0)
  const controller = createMeterController(options)
  const unwire = wireV1(api, controller, () => setRev((n) => n + 1))

  const timer = setInterval(() => {
    controller.tick()
    setBeat((n) => n + 1)
  }, 1000)

  api.lifecycle.onDispose(() => {
    clearInterval(timer)
    unwire()
  })

  api.slots.register({
    slots: {
      session_prompt_right(_ctx, props) {
        return (
          <MeterLine
            sessionID={props.session_id}
            store={controller.store}
            rev={rev}
            beat={beat}
            options={options}
            palette={() => v1Palette(api.theme.current)}
          />
        )
      },
    },
  })
}

/**
 * Dual-shape default export. `Plugin.define` is an identity function, so a
 * plain object works at runtime for V2 and avoids importing `@opencode/plugin`
 * (kept as a type-only dependency) into the V1 code path.
 */
const plugin = {
  id: "opencode-token-metrics",
  setup: setupV2,
  tui,
}

export default plugin as TuiPluginModule & { setup: (ctx: Context) => void | (() => void) }
