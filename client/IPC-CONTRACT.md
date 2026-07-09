# Hydropark IPC contract — Rust core ↔ Angular webview

> `SPRINT-BACKLOG.md` §6 lists this document as a **Ready-blocker for `P1-01.7`** and for everything
> crossing Rust↔Angular (streaming, state bus, tool routing). This is that contract, authored against
> the Phase-0 prototype. It is deliberately small: Phase 0 has three tools and four widgets.

## Where the schema lives

The schema is written **twice, on purpose**, and the two copies must stay identical:

| Side | File | Mechanism |
|---|---|---|
| Webview | `web/src/app/ipc/contract.ts` | TypeScript types |
| Core | `src-tauri/src/ipc.rs` | `serde` structs/enums, `#[serde(rename_all = "snake_case")]` |

The wire format is **snake_case JSON** on both sides. Rust enum variants carry
`#[serde(rename_all = "snake_case")]` so `ToolName::StartTimer` serializes as `"start_timer"`,
matching `ToolName = 'start_timer' | ...` in TypeScript.

> A duplicated cross-boundary contract drifts. It happened in the backend: the step-up action strings
> were defined in two packages, diverged (`devices.register` vs `device.register`), and silently
> disabled trust-on-first-use — nothing failed to compile. If this contract grows past Phase 0,
> generate one side from the other rather than maintaining two hand-written copies.

## Responsibility split

The rule: **the core owns anything that must remain true when the webview is not looking.**

| Rust core owns | Webview owns |
|---|---|
| Inference (llama.cpp, token streaming) | Rendering, layout, transitions |
| Tool registry, arg validation, execution | Input, focus, `prefers-reduced-motion` |
| Timers (they must fire when backgrounded) | Timer *display* and controls |
| Canonical app state (`AppState`) | Derived view state |
| Filesystem, OS notifications, sound | — |
| Telemetry sink (JSONL append) | Emitting telemetry events |

Timers are the clarifying case. A countdown lives in `src-tauri/src/tools.rs` behind
`AppState(Arc<Mutex<AppStateInner>>)`, **not** in an Angular `setInterval` — a webview may be
throttled or suspended when the window is backgrounded, and `P0-05.4` requires the timer to fire and
notify regardless. The webview renders a projection of state it does not own.

## Message families

### 1. Tool calls — `ToolCallRequest` → `ToolCallResponse`

```ts
type ToolName = 'start_timer' | 'convert_units' | 'list_manage';
type ToolCallSource = 'ui' | 'model';

interface ToolCallRequest<T extends ToolName> {
  source: ToolCallSource;
  name: T;
  args: ToolArgsMap[T];
}

type ToolCallResponse<T> = { ok: true; result: ToolResultMap[T] } | { ok: false; error: ToolCallError };
```

`source` is the load-bearing field.

- `source: 'ui'` — the user tapped a control. The core executes the tool **directly, with no model
  round-trip** (`P0-03.6`). This is the primary path and the reliability backstop.
- `source: 'model'` — the tool call was parsed out of a Qwen-native `<tool_call>` block. The core
  validates `name` against the registry and the args against the typed schema
  (`tools::validate_and_parse`) **before** executing. A malformed call surfaces a prefilled widget or
  one clarifying question — never a repair loop (`P0-04.2`).

A 3B model *will* emit malformed tool calls. The product is designed so that this degrades the chat
affordance, not the tool.

### 2. Inference streaming — `InferenceStartArgs` → token events

The core streams tokens to the webview over a Tauri event channel. The webview never sees the model
handle. `tok/s` is measured in the core and emitted as telemetry (`P0-02.3`), because it is a
covariate for the H1 read and the webview cannot measure it honestly.

### 3. State bus

The core is the single writer of canonical state (timers, ingredient list, unit system). The webview
subscribes to state snapshots. Flipping `segmented_toggle` mutates the unit system **in the core**,
which then re-emits both the chat transcript and the list re-expressed in the new system — that is
why one toggle changes two widgets (`P0-03.5`).

### 4. Telemetry — append-only JSONL

Events (`skill_enabled`, `timer_started`, `list_edited`, `units_flipped`, `tok_per_sec`, `outcome`)
are emitted by the webview and appended by the core. One shared event schema is used by both the app
log and the H2 eval harness (`P0-06.2`), so session recordings and eval runs are comparable.

## Phase-1 note

This contract is Phase-0 shaped: three fixed tools, four fixed widgets, no skill packages. Phase 1
replaces it — `P1-06` alone brings ~12 widgets whose typed props/state/event schemas are themselves a
Ready-blocker, and tools become dynamic, arriving inside signed `.hpskill` packages. Expect the
`ToolName` union to become a registry keyed at runtime, and expect the arg schema to move from
compile-time types to a validated JSON Schema shipped with each skill.
