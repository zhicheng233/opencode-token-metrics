# opencode-token-metrics

[![npm version](https://img.shields.io/npm/v/opencode-token-metrics)](https://www.npmjs.com/package/opencode-token-metrics)

A live throughput meter for the [OpenCode](https://opencode.ai) TUI, for **V1 and V2**. It renders beside the session prompt as a VU-style time-series of generation speed, with average, peak, trend, and time-to-first-token.

```
tok/s ▃▆▇▇█▆▄ 42.0 ▲15% · avg 38.2 · pk 45.0 · ttft 0.8s
```

![opencode-token-metrics running in the OpenCode TUI](assets/demo.gif)

## What it looks like

The graph grows one column per second as the model streams, scaled to the turn's busiest second:

```
tok/s ▁ 18.0                                             first token
tok/s ▁▃▅ 33.0 ▲12%                                      ramping up
tok/s ▃▆▇▇█ 45.0 ▲18% · avg 41.2 · pk 45.0 · ttft 0.8s
tok/s ▃▆▇▇█▆▄ - · avg 41.2 · pk 45.0 · ttft 0.8s         tool call — average holds
tok/s ▃▆▇▇█▆▄█▆ 43.0 ▲2% · avg 41.0 · pk 45.0 · ttft 0.8s   resumed
tok/s ▃▆▇▇█▆▄█▆ 43.0 · avg 41.0 · pk 45.0 · ttft 0.8s        holds, scaled to exact tokens
tok/s idle                                               nothing running
```

The rate and trend are color-coded: red below `slowTps`, yellow up to `fastTps`, green at or above it.

- **VU meter** — one half-block column per second, growing as the turn progresses (no reserved empty space), scaled to the turn's busiest second
- **Average** — active generation speed: tokens per second over the time actually spent streaming, so tool pauses don't drag it down
- **Held frame** — when a turn ends the graph, rate, average, peak, and TTFT freeze and stay on screen until the next turn produces tokens
- **Exact totals** — on completion the graph and peak are rescaled to the provider's reported token count
- **Peak hold** — the fastest rate observed during the turn, never below the average
- **Trend** — up/down against the previous second, with percent
- **TTFT** — time from the assistant message being created to the first streamed token

## Install

One package serves both OpenCode generations and the TUI picks the matching
entrypoint, so install it the way your OpenCode version expects.

### V2 (2.x)

Add it to the `plugins` array in your OpenCode config
(`~/.config/opencode/opencode.jsonc` or `opencode.json`):

```jsonc
{
  "plugins": ["opencode-token-metrics"]
}
```

V2 options use the object form:

```jsonc
{
  "plugins": [
    { "package": "opencode-token-metrics", "options": { "vuColumns": 20, "vuScale": "fixed", "vuFullTps": 80 } }
  ]
}
```

The meter renders into the prompt footer status slot. Restart the TUI afterwards — plugins load at startup and are not hot-reloaded.

### V1 (1.x)

```bash
opencode plugin opencode-token-metrics -g
```

This installs the package from npm and adds it to `~/.config/opencode/tui.json`. TUI plugins belong in `tui.json`, **not** `opencode.json`.

Manual setup:

```jsonc
// ~/.config/opencode/tui.json
{
  "plugin": ["opencode-token-metrics"]
}
```

V1 options use the tuple form:

```jsonc
{
  "plugin": [
    ["opencode-token-metrics", { "vuColumns": 20, "vuScale": "fixed", "vuFullTps": 80 }]
  ]
}
```

The package ships TypeScript source and is transpiled by OpenCode's own runtime, so there is no separate build step.

## Install (for AI agents)

If you are an agent installing this for a user, first tell the OpenCode
generation apart, then follow the matching procedure.

```text
GOAL: install opencode-token-metrics into the user's OpenCode TUI.

Detect the generation (from `opencode --version` or the config layout):
  - V2 (2.x): plugins are listed under "plugins" in opencode.json / opencode.jsonc.
  - V1 (1.x): TUI plugins are listed under "plugin" in tui.json.

V2:
1. Add "opencode-token-metrics" to the "plugins" array in the user's OpenCode
   config (opencode.json or opencode.jsonc). Do NOT remove sibling entries.
   Do NOT add a version suffix.
2. Options use the object form:
   { "package": "opencode-token-metrics", "options": { "alwaysShow": true } }.

V1:
1. Run: opencode plugin opencode-token-metrics -g
2. This installs the npm package and adds "opencode-token-metrics" to the
   "plugin" array in ~/.config/opencode/tui.json.
3. If the installer is unavailable, add "opencode-token-metrics" to that
   "plugin" array by hand. Do NOT remove sibling entries. Do NOT add a version suffix.
4. TUI plugins go in tui.json, never opencode.json.

Both:
- Do not touch any other top-level key in the config.
- Tell the user to restart the TUI. Plugins load at startup; there is no hot reload.
```

## Options

V1 passes options as the second element of the plugin tuple; V2 uses
`{ "package": "opencode-token-metrics", "options": { ... } }`. The keys are the same either way:

```jsonc
// V1 (tui.json)
{ "plugin": [["opencode-token-metrics", { "vuColumns": 20, "showTtft": false }]] }

// V2 (opencode.jsonc)
{ "plugins": [{ "package": "opencode-token-metrics", "options": { "vuColumns": 20, "showTtft": false } }] }
```

| Option | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Disable rendering without uninstalling |
| `rollingWindowMs` | `5000` | Averaging window for the live rate |
| `idleTimeoutMs` | `1500` | Silence after which the rate reads as inactive |
| `minSpanMs` | `300` | Floor on the elapsed span so early samples don't spike |
| `vuColumns` | `12` | Maximum seconds of history shown in the VU meter |
| `vuScale` | `"auto"` | `auto` scales columns to the turn peak; `fixed` uses `vuFullTps` |
| `vuFullTps` | `50` | Full-scale tokens/sec when `vuScale` is `fixed` |
| `slowTps` | `10` | Below this is "slow" (red) |
| `fastTps` | `30` | At or above this is "fast" (green) |
| `showVu` | `true` | Show the VU meter |
| `showTrend` | `true` | Show the trend arrow |
| `showAvg` | `true` | Show the turn average |
| `showPeak` | `true` | Show the peak |
| `showTtft` | `true` | Show time to first token |
| `showTokenCount` | `false` | Show the token counter |
| `showElapsed` | `false` | Show elapsed turn time |
| `alwaysShow` | `false` | Keep the meter visible when idle instead of hiding it |
| `idleText` | `"idle"` | Placeholder shown with `alwaysShow` when there is no data (`tok/s idle`) |
| `label` | `"tok/s"` | Leading label |

## How it works

All measurement lives in `src/meter.ts`. `src/controller.ts` is a
version-agnostic core, and a thin adapter per generation translates that
generation's event bus into the same normalized events.

**OpenCode V1** (`src/v1.ts`, installed via `tui.json`, renders in `session_prompt_right`):

- `message.updated` — on an assistant message being created, opens a turn and records its start time (for TTFT). On completion, swaps the estimate for the provider's exact `tokens.output + tokens.reasoning`, freezes the final frame, and keeps it on screen.
- `message.part.delta` — records streamed `text` and `reasoning` chunks and buckets them per second.
- `message.part.updated` — restarts the live rate when a tool part runs, while keeping the graph continuous across the gap.
- `session.deleted` — frees that session's meter.

**OpenCode V2** (`src/v2.ts`, installed via `plugins`, renders in `prompt.footer.status`):

- `session.step.started` — opens the assistant turn and records its start time (for TTFT).
- `session.text.delta` / `session.reasoning.delta` — record streamed output and bucket it per second.
- `session.tool.called` — restarts the live rate when a tool runs, keeping the graph continuous across the gap.
- `session.step.ended` / `session.step.failed` — accumulate the provider's exact token usage per step.
- `session.execution.succeeded` / `.failed` / `.interrupted` — finish the turn with the summed tokens and freeze the final frame.
- `session.deleted` — frees that session's meter.

The live rate is `tokens in window / elapsed span` over the trailing window, measured on the wall clock. The average is `turn tokens / active generation time` — the time spent streaming, excluding tool pauses. Peak is the highest one-second rate seen during the turn (never below the average); trend compares the last two complete seconds. VU columns auto-scale to the largest bucket in view, scaled to the provider's exact token total when the turn completes.

## License

MIT
