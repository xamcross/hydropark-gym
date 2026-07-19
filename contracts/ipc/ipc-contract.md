# Hydropark IPC Contract — Rust core ↔ Angular webview (Phase 1, production)

> **Status:** authoritative. This document and its sibling
> [`ipc-messages.schema.json`](./ipc-messages.schema.json) are the single source of truth for
> every message that crosses the Tauri webview/core boundary in the shippable MVP. The certification
> pipeline (`P1-05`, skill behavioral eval) and the client both validate recorded IPC traces against
> the JSON Schema; this Markdown is the prose contract the schema encodes.
>
> **Supersedes** the Phase-0 seed (`client/IPC-CONTRACT.md`, `client/web/src/app/ipc/contract.ts`,
> `client/src-tauri/src/ipc.rs`). Phase 0 had three hard-coded tools and four fixed widgets with no
> composition and no shared-state bus. Phase 1 is fuller: **dynamic tools arriving in signed
> `.hpskill` packages, a ~12-widget library, multi-skill composition, a per-agent event+state bus,
> and a capacity meter.** Where a Phase-0 message survives, it is called out.

Protocol id: **`hydropark.ipc/1`**. Every message carries `v: 1`. Breaking changes bump `v` and this
document's major.

---

## 0. Reading guide

- **§1 Transport & envelope** — the wire model, the two channels, the self-describing envelope, the
  Tauri binding, and the global ordering/idempotency rules every message inherits.
- **§2 Responsibility split** — the Rust-owns / webview-owns table (required by the task).
- **§3 Message catalog** — every message, grouped by family. Each family has a table
  (`Message | type | Direction | Payload | Ordering / Idempotency`) followed by prose. Families:
  §3.1 Handshake · §3.2 Composition & orchestrator · §3.3 Inference streaming ·
  §3.4 Tool calls & routing · §3.5 The four-direction bus · §3.6 Timers ·
  §3.7 Skills, licensing & verify · §3.8 Notifications, telemetry, hardware.
- **§4 The four-direction bus in one page** — SPEC §9.3 mapped onto §3 messages.
- **§5 Versioning & drift control.**

Direction notation:

| Notation | Meaning | Tauri mechanism |
|---|---|---|
| **UI→core** | webview issues a request, awaits a typed result | `invoke(cmd, args) → Promise<result>` |
| **core→UI** | core pushes; fire-and-forget | `emit(channel, payload)` / `listen(channel, cb)` |
| **↔** | a request/response pair whose result is itself part of the contract | `invoke` + a follow-up event stream |

---

## 1. Transport & envelope

### 1.1 Two channels, one envelope

There are exactly two transport primitives, unchanged from Phase 0:

1. **Commands** — `UI→core` request/response over `invoke`. The webview initiates; the core answers
   with a typed result or rejects with a `CmdError` (§3, *Errors*).
2. **Events** — `core→UI` pushes over `emit`/`listen`. The core initiates; there is no reply.

Phase 1 adds a **self-describing envelope**: unlike Phase 0 (where the message type was implicit in
the Tauri channel name and payloads were bare structs), every Phase-1 message — command args, command
result, and event — is a JSON object carrying its own `type` and `v`. This is what lets the
certification harness and the session recorder validate a captured trace **standalone**, and lets the
orchestrator multiplex one logical bus over many Tauri channels.

**Envelope (common fields on every message):**

| Field | Type | Present on | Notes |
|---|---|---|---|
| `v` | `1` | all | Protocol version. A mismatch is a fatal handshake error (§3.1). |
| `type` | string | all | Namespaced discriminator, e.g. `inference/token`. The `oneOf` key in the schema. |
| `channel` | `command` \| `response` \| `event` | all | Redundant with `type` but explicit for logs/replay. |
| `ts_ms` | int (epoch ms) | all | Producer clock. Advisory only — never used for ordering (see §1.3). |
| `agent_id` | string | agent-scoped | The composed-agent/session this belongs to. Absent on process-global msgs (handshake, hardware). |
| `session_id` | string | conversation-scoped | A chat session within an agent. |
| `request_id` | UUID | command/response | Correlates a `response` to its `command`; the idempotency key. |
| `turn_id` | UUID | inference-scoped | Correlates all events of one inference turn (tokens, tool calls, done). |
| `seq` | int ≥ 0 | ordered streams | Monotonic **within its stream key** (see §1.3). |

The schema models this with a shared `envelope` `$def`; each message pins `type`/`channel` to a
`const`, adds its own fields, and closes with `unevaluatedProperties: false`.

### 1.2 Tauri binding (transport mapping)

| Logical | Tauri call | Channel/command name |
|---|---|---|
| Command `type: "inference/start"` | `invoke("inference/start", <msg>)` | command name **is** the `type` string |
| Event `type: "inference/token"` | `emit("inference/token", <msg>)` | event channel **is** the `type` string |
| Command result | `Promise` resolve value | a `channel: "response"` message |
| Command error | `Promise` reject value | serialized `CmdError` (§3, *Errors*) |

The binding is 1:1: **channel name == `type`**. No message multiplexes two `type`s onto one channel.
Args and results are the full enveloped objects (not bare payloads), so a Tauri log line is a valid
schema instance on its own.

### 1.3 Global ordering & idempotency rules

Individual messages refine these in §3; the defaults are:

- **Ordering is per-stream, never global.** A *stream key* is:
  - inference tokens/events → `(session_id, turn_id)`, ordered by `seq` (0-based, **contiguous**);
  - shared-state slots → `(agent_id, slot)`, ordered by the slot's monotonic `version` (not `seq`);
  - timers → `(timer_id)`, where snapshots supersede ticks.
  Messages from different stream keys may interleave arbitrarily. The webview must not assume a global
  order across families.
- **Commands are idempotent by `request_id`.** The core dedupes; a re-delivered command returns the
  original result and does not re-execute the side effect. Clients generate `request_id` (UUIDv4).
- **State mutations use optimistic concurrency.** A writer sends the `base_version` it observed; the
  core applies iff `base_version == current`, else rejects with `stale_version` and the webview
  requests a fresh snapshot (§3.5). Every accepted mutation increments `version` by exactly 1.
- **Streams self-heal.** A dropped `inference/token` (gap in `seq`) is unrecoverable → the webview
  cancels and surfaces an error; a dropped `timer/tick` is harmless because the next tick carries the
  absolute `remaining_sec`, and `timer/updated` snapshots are fully idempotent.
- **Fire-and-forget messages carry their own dedupe key.** `telemetry/log` events are append-only and
  keyed by `(session_id, ts_ms, event)`; `notify` is best-effort.

---

## 2. Responsibility split (Rust core vs. webview)

The rule, unchanged from Phase 0 and load-bearing in Phase 1: **the core owns anything that must
remain true when the webview is not looking** — anything that must survive a throttled/suspended
webview, must not be forgeable by renderer code, or *is the paid IP*.

| Concern | **Rust core owns** | **Webview owns** |
|---|---|---|
| **Inference** | llama.cpp session, KV cache, GBNF/JSON-schema-constrained decoding, token streaming, `tok/s` measurement | Appending tokens to the transcript; the typing cursor; scroll |
| **Tool runtime** | The **audited tool catalog**, per-tool arg **validation** (against the skill-shipped JSON Schema), execution, `writes_state`/`reads_state`/`updates_widget` **routing** | Invoking tools from widget actions (UI-first path); rendering results |
| **Composition** | The **Orchestrator**: deterministic merge (primary→priority→id), tool namespacing/aliasing, panel dedup, prompt assembly, capacity projection & block/warn | Animating panels in/out; showing the capacity meter; the "drop a skill" prompt |
| **Shared-state store** | The **per-agent shared store**: canonical slot values, slot **schemas**, **writer-of-record** arbitration, append/patch commutativity by entry `id`, versioning, persistence (SQLite) | Two-way widget binding *display*; disabling edit affordances on read-only bindings |
| **Conversation/bus** | Appending `to_chat` system lines to the transcript; deciding when a widget event is time-critical | Emitting widget events; deciding a widget's `to_chat` default per its type |
| **Timers** | The countdown **source of truth** (fires when backgrounded), tick emission, finish detection | Timer display, progress ring, pause/reset **controls** |
| **Licensing / verify** | `.hpskill` **Ed25519 signature verification** (offline, embedded public key), entitlement/unlock checks, license-token validation, `min_app_version`/`min_widget_version`/`min_model_tier` gating | The locked-state UI; the unlock/purchase flow surface |
| **Persistence & OS** | SQLite + files (all local), OS notifications + sound, filesystem, model GGUF management | `prefers-reduced-motion`, focus order, keyboard nav, theming from design tokens |
| **Telemetry** | The JSONL **sink** (validate `schema_version`, append) | Emitting telemetry events (it knows the UI-side "why") |
| **Model↔UI boundary** | Enforces that the model can touch the UI **only** via tools/slots (never UI code/directives); the model may *read* slots as context | Rendering the resulting state; never trusting model output as markup |

**Why the split lands where it does — two clarifying cases:**

- **Timers** live behind `AppState(Arc<Mutex<…>>)` in the core, not an Angular `setInterval`, because a
  backgrounded webview may be throttled/suspended and the finished-timer notification must still fire
  (SPEC §9.7). The webview renders a *projection* of state it does not own.
- **The full `system_prompt` never crosses this boundary.** Per BACKEND-DESIGN §3.2/§4.2, the paid
  persona is IP: the backend serves only `compressed_prompt` pre-purchase, and the full prompt lives
  only inside the signed `.hpskill`. The core loads it into the llama.cpp context and **never emits it
  over IPC** — not in `agent/composed`, not in any event. The webview learns *that* a persona is
  active and its capacity cost, never its text.

---

## 3. Message catalog

### 3.1 Handshake & protocol

| Message | `type` | Direction | Payload | Ordering / Idempotency |
|---|---|---|---|---|
| Ready | `ipc/ready` | core→UI | `{ protocol_v, app_version, widget_library_version, model_id, hardware }` | Emitted **exactly once** after the core is up, before any agent message. Idempotent (webview keeps the last). |
| Fatal | `ipc/error` | core→UI | `{ code, message, fatal }` | Transport/protocol-level only. Not tied to a `request_id`. |

`ipc/ready` carries the read-only `HardwareProfile` (`{ ram_gb, cores, gpu_present }`) so the webview
can render the capacity meter's hardware tier without a round-trip. A `v` mismatch here is fatal: the
webview must refuse to drive an incompatible core.

### 3.2 Composition & orchestrator (SPEC §8.3)

| Message | `type` | Direction | Payload | Ordering / Idempotency |
|---|---|---|---|---|
| Compose | `agent/compose` | UI→core | `AgentComposeRequest` | Idempotent by `composition_hash` (§below). Re-issuing the same set returns the same `MergeResult`. |
| Composed | `agent/composed` | core→UI *(also the command result)* | `MergeResult` | The authoritative merge outcome. Supersedes any prior `MergeResult` for this `agent_id`. |
| Blocked | `agent/compose_blocked` | core→UI *(or command reject)* | `ComposeBlock` | Terminal for that compose attempt; carries a remedy. No partial agent is created. |
| Capacity | `bus/capacity` | core→UI | `CapacityProjection` | Re-emitted as the conversation grows; ordered by `seq` per `agent_id`. Latest wins. |
| Dispose | `agent/dispose` | UI→core | `{ agent_id }` | Idempotent; disposing an unknown agent is a no-op success. |

**`agent/compose` request:**

```jsonc
{
  "v": 1, "type": "agent/compose", "channel": "command",
  "request_id": "…", "agent_id": "agt_…",
  "base_model": "qwen2.5-3b-instruct-q4_k_m",
  "skills": [
    { "skill_id": "cooking-assistant", "version": "1.2.0", "role_pref": "primary" },
    { "skill_id": "nutrition-coach",    "version": "1.0.0" }
  ],
  "primary_skill_id": "cooking-assistant",   // optional; else default = highest combine_priority
  "composition_hash": "sha256:…"             // hash of {sorted skill@version, base_model}; the idempotency key
}
```

**`MergeResult` (`agent/composed`)** is the orchestrator's deterministic output (SPEC §8.3.2 order:
**primary → `combine_priority` desc → `id` asc**). It carries:

- `primary` — `{ skill_id }` of the lead voice, or `{ base_agent: true }` when no active skill is
  `primary_eligible` (SPEC §8.3.1 fallback). **No prompt text** (IP; see §2).
- `secondaries[]` — ordered `skill_id`s contributing `compressed_prompt` + tools + panels + slots.
- `tools[]` — the merged tool contract: each `{ name, owner_skill_id, namespaced?: "cooking.convert_units",
  alias_of?, writes_state[], reads_state[], updates_widget? }`. Union across skills; a shared `ref`
  with compatible config is one entry; conflicting config yields a namespaced entry and the merge order
  decides which owns the un-namespaced alias (SPEC §8.3.3).
- `slots[]` — the shared-state table: each `{ slot, kind, schema, access, writer_of_record: skill_id,
  version: 0 }` (SPEC §8.3.4). This tells every widget which bindings are two-way vs. read-only.
- `panels[]` — the resolved panel dock: **canonical** widget contracts (shorthand already normalized,
  SPEC §9.2), placed by `region` then `priority`, **deduplicated** where type+id+binding match, each
  gated by `min_widget_version` (an unknown/too-new widget is flagged `placeholder: true`, SPEC §9.8).
- `capacity` — the initial `CapacityProjection` (below).
- `composition_hash` — echoed, so the webview can confirm idempotency.

**`ComposeBlock` (`agent/compose_blocked`)** — a composition that cannot be built, with a remedy the UI
renders verbatim:

```jsonc
{
  "v":1, "type":"agent/compose_blocked", "channel":"event", "agent_id":"agt_…",
  "reason": "context_overflow" | "conflict" | "incompatible_slot_schema" | "model_tier",
  "message": "…user-facing…",
  "suggest_drop_skill_id": "nutrition-coach",           // for context_overflow (SPEC §8.3.5)
  "conflict_skills": ["a","b"],                          // for conflict (SPEC §8.3.6 conflicts_with)
  "slot": "ingredients", "differing_fields": ["unit"]   // for incompatible_slot_schema (SPEC §8.3.4)
}
```

**`CapacityProjection` (`bus/capacity`)** — SPEC §8.3.5, *"capacity" = compute (memory + speed), not
money*:

```jsonc
{
  "v":1, "type":"bus/capacity", "channel":"event", "agent_id":"agt_…", "seq": 3,
  "status": "ok" | "warn" | "blocked",
  "context": {
    "window_tokens": 8192, "safety_margin_tokens": 512,
    "working_reserve_tokens": 2048,                 // fixed reserve so live chat always has room
    "used_tokens": 5100,                            // Σ(primary prompt, each secondary compressed, tool schemas, few-shot)
    "breakdown": [ { "skill_id":"cooking-assistant","tokens":380,"source":"certified" } ]
  },
  "speed": { "tier":"cpu-8c", "est_tok_per_sec": 14.2, "est_first_token_ms": 900, "sluggish_threshold_tok_per_sec": 8 },
  "action": null | "condensed_history"              // set when the core condensed old history instead of auto-disabling
}
```

Semantics the webview must honor:

- **`status: "blocked"`** — projected context exceeds `window − safety_margin`. On **`agent/compose`**
  this arrives as `agent/compose_blocked` (`reason:"context_overflow"`) and **no agent is created**.
  Per-skill figures come from the **certification-measured** `cost_estimate`, not the manifest's
  self-declared value (SPEC §8.3.5).
- **`status: "warn"`** — the **speed-headroom warning** (amber meter): predicted `tok/s` crosses the
  sluggish threshold. The combo is **allowed**; the webview shows amber and proceeds.
- **Never auto-disable mid-session.** As the conversation grows the core re-emits `bus/capacity`; if
  headroom runs low it **condenses old history** (`action:"condensed_history"`) and warns — it never
  drops a skill on its own. Control stays with the user (SPEC §8.3.5).

### 3.3 Inference streaming (SPEC §8.4)

| Message | `type` | Direction | Payload | Ordering / Idempotency |
|---|---|---|---|---|
| Start | `inference/start` | UI→core | `{ agent_id, session_id, user_message }` → result `{ turn_id }` | One in-flight turn per `session_id`; starting while one runs rejects `turn_in_flight`. Idempotent by `request_id`. |
| Cancel | `inference/cancel` | UI→core | `{ session_id, turn_id }` | Cooperative. Idempotent: cancelling an already-finished/absent turn is a no-op success. |
| Token | `inference/token` | core→UI | `{ session_id, turn_id, seq, token }` | **`seq` is 0-based and contiguous** per `(session_id,turn_id)`. Dedupe by `seq`; a gap is unrecoverable → webview cancels + errors. |
| Tool call | `inference/tool_call` | core→UI | `InferenceToolCall` | Emitted after the core parsed **and already decided validity** of a model `<tool_call>`. `hop` is 0-based within the turn. Render-only. |
| Tool result | `inference/tool_result` | core→UI | `{ …, tool, result, routing }` | Follows a **valid** `inference/tool_call`; the core already executed it. Carries the same `RoutingDirective` as UI-path results (§3.4). |
| Fallback | `inference/tool_fallback` | core→UI | `InferenceToolFallback` | Emitted when validate→repair→fallback is exhausted (§below). At most one per failed call. |
| Done | `inference/done` | core→UI | `{ turn_id, tokens_generated, elapsed_ms, tok_per_sec, hops, finish_reason }` | Terminal for a turn; exactly one. `finish_reason ∈ stop|cancelled|max_hops`. |
| Error | `inference/error` | core→UI | `{ session_id, turn_id?, message }` | Terminal for a turn (mutually exclusive with `done`). |

**Streaming order within a turn:** `inference/token*` interleaved with zero or more
`inference/tool_call` (+ its `inference/tool_result` **or** `inference/tool_fallback`), terminated by
exactly one of `inference/done` | `inference/error`. Tokens across the whole turn share one contiguous
`seq` space so the transcript reconstructs exactly even when tool calls interrupt prose.

**Cancel semantics:** `inference/cancel` is cooperative — the core stops decoding at the next token
boundary and emits `inference/done` with `finish_reason:"cancelled"` (not `inference/error`). Tokens
already emitted stay in the transcript. Cancelling is idempotent.

**Tool-calling reliability (SPEC §8.4), Phase-1 fuller than P0:** the turn runs under a two-branch
GBNF grammar (prose **or** one Qwen-native `<tool_call>`). A produced call is validated against the
tool's JSON Schema; **Phase 1 adds the one automatic repair attempt** (re-prompt with the validation
error) that P0 deliberately cut. Only if repair also fails does `inference/tool_fallback` fire:

```jsonc
{
  "v":1,"type":"inference/tool_fallback","channel":"event","session_id":"…","turn_id":"…",
  "reason": "malformed_json" | "unknown_tool" | "invalid_args" | "max_hops",
  "repair_attempted": true,
  "tool": "start_timer" | null,                 // best-effort name if it parsed
  "parsed_args": { "duration_sec": 540 } | null,// whatever args did parse, to prefill with
  "updates_widget": "timers" | null,            // the tool's bound widget, to surface prefilled
  "clarifying_question": "Set a timer? For how long?" | null  // set only when no widget maps
}
```

The webview degrades to **exactly one** of: surface `updates_widget` prefilled with `parsed_args`
(SPEC §8.4 fallback→widget mapping), or post `clarifying_question` to chat. It **never** re-validates
and **never** loops. `tok/s` is measured in the core (a covariate for the eval read; the webview
cannot measure it honestly) and reported on `inference/done` + as telemetry.

### 3.4 Tool calls & routing (SPEC §8.4, §9.3 last ¶)

| Message | `type` | Direction | Payload | Ordering / Idempotency |
|---|---|---|---|---|
| Call | `tool/call` | UI→core | `ToolCallRequest` → result `ToolCallResponse` | Idempotent by `request_id`. The **UI-first path** — no model round-trip. |

```jsonc
// ToolCallRequest — the widget-action / UI-first path (SPEC §8.4 point 1)
{ "v":1,"type":"tool/call","channel":"command","request_id":"…","agent_id":"agt_…",
  "tool":"list_manage",            // runtime string; may be namespaced "cooking.convert_units"
  "args": { "op":"add","item":{"name":"basil"} },  // validated in-core vs the skill-shipped JSON Schema
  "source":"ui" }                  // 'ui' (tap/edit) — see note on 'model'
```

**`source` is the load-bearing field.**

- `source:"ui"` — the user tapped/edited a bound widget. The core executes **directly, no model
  round-trip** (the reliability backstop). This is the primary caller of `tool/call`.
- `source:"model"` — retained for symmetry/telemetry, but a **model** tool call does **not** cross as
  a `tool/call` command: it is parsed inside the core from the constrained stream and surfaces as
  `inference/tool_call` + `inference/tool_result` (§3.3). Untrusted model tool names/args are therefore
  validated entirely core-side before any typed result reaches the webview.

**`ToolCallResponse`** (also the shape carried by `inference/tool_result.result` + `routing`):

```jsonc
// ok
{ "v":1,"type":"tool/call","channel":"response","request_id":"…","ok":true,
  "tool":"list_manage","result": { … tool-specific … },
  "routing": { "route":"state","writes_state":["ingredients"],"slot_version":8 } }
// error
{ "v":1,"type":"tool/call","channel":"response","request_id":"…","ok":false,
  "tool":"list_manage","error": { "code":"invalid_args","message":"…" } }
```

**Routing (`RoutingDirective`) — SPEC §9.3 last paragraph.** A tool ref declares `writes_state` /
`reads_state` in its manifest entry; this explicit declaration — **not name-guessing** — is the
binding, and routing is keyed on **slot name** so it stays unambiguous when a tool is shared or
namespaced across skills, or when several widgets bind one slot:

| `route` | When | Effect on the webview |
|---|---|---|
| `state` | tool declares `writes_state` | The named slots changed → the core emits `bus/state_patch` per slot (§3.5); **every** widget with `binds_state` on that slot re-renders. `slot_version` is the post-op version. |
| `widget` | tool returns a result but declares no `writes_state`, and has `updates_widget` | The result routes to that one widget. |
| `chat` | default — no `writes_state`, no `updates_widget` | The result routes to the chat transcript. |

Tool *execution* errors (e.g., invalid unit) return a structured `error` the model must acknowledge to
the user — the app never silently swallows a failed action (SPEC §8.4 point 4).

### 3.5 The four-direction event + state bus (SPEC §9.3)

Each active agent has **one** event+state bus. These messages implement its four directions; §4 maps
them back to the SPEC's numbered directions.

| Message | `type` | Direction | Payload | Ordering / Idempotency |
|---|---|---|---|---|
| Snapshot | `bus/state_snapshot` | core→UI | `{ slot, kind, schema, value, version, writer_of_record }` | Full slot value. Sent on compose, on (re)subscribe, and to recover from `stale_version`. Idempotent (version-stamped). |
| Patch | `bus/state_patch` | core→UI | `StatePatch` | Delta on one slot. Apply iff `base_version == local`; else request a snapshot. `version = base_version + 1`. |
| Write | `bus/state_write` | UI→core | `{ slot, base_version, op, entry?/entries?/value }` → result `{ slot, version }` | Two-way widget→slot write. **Rejected** `not_writer_of_record` unless the widget's skill is writer-of-record; `stale_version` on optimistic-concurrency miss. Idempotent by `request_id`. |
| Widget event | `bus/event` | UI→core | `{ widget_id, event_name, to_chat, time_critical?, payload? }` → result `void` | Direction 4. **Never triggers inference.** Idempotent by `request_id`. |
| Transcript line | `bus/transcript_append` | core→UI | `{ session_id, line, kind:"system", source_widget_id?, notified? }` | The core-appended `to_chat` system line to render. Ordered after the event that caused it. |

**`StatePatch` (`bus/state_patch`):**

```jsonc
{ "v":1,"type":"bus/state_patch","channel":"event","agent_id":"agt_…",
  "slot":"ingredients","kind":"list","base_version":7,"version":8,
  "op":"append" | "patch" | "remove" | "set",   // 'set' only for scalar slots / writer-of-record
  "entries":[ { "id":"itm_3","name":"basil","qty":2,"unit":"tbsp" } ],  // list/record ops, keyed by entry id
  "value": null,                                 // scalar 'set' payload
  "cause": { "kind":"tool","request_id":"…" } | { "kind":"model","turn_id":"…" } | { "kind":"ui","request_id":"…" } }
```

Write-arbitration rules the core enforces (SPEC §8.3.4), so the webview can trust every patch:

- **One writer-of-record per slot** — the highest-priority `read_write` declarer. `set` (scalars) and
  destructive ops come only from it.
- **Cross-skill append/patch is commutative by entry `id`** — non-writers may `append`/`patch` via
  tools (adds and field-updates that don't delete others' entries); order-independent, so concurrent
  contributions converge.
- **Two-way binding only for the writer-of-record** (SPEC §8.3.4 reconciliation): a widget bound to a
  slot its skill does **not** own is read-only — it renders live patches but its edit affordances are
  disabled with a tooltip naming the owner, so `bus/state_write` from it is rejected defensively. This
  removes the apparent conflict between "two-way binding" (§9.3 #1) and "one writer-of-record."

**`bus/event` — direction 4, the critical no-auto-inference rule (SPEC §9.3 #4):** a widget event
carries a `to_chat` flag (a per-widget-type default, overridable per event in the widget's `emits`).
When `to_chat` is true the core appends a system line to the transcript (surfaced back as
`bus/transcript_append`) and, if `time_critical`, fires the OS notification (§3.6/§9.7). **Posting an
event does *not* run inference** — the transcript stays a complete record, but the model responds only
when the **user** sends the next turn. This is the "UI→model" channel: deferred, never a background
wake. (A finished timer is the canonical time-critical case; it originates core-side and appends via
`bus/transcript_append` directly.)

**Model↔UI bridge (SPEC §9.3):** the model changes the UI **only** by calling tools or writing slots;
it may *read* slots as context but **never emits UI code/directives**. "The agent fills the ingredient
list from a recipe" is really: model calls `list_manage` → `writes_state:["ingredients"]` → the core
emits `bus/state_patch` → the bound `editable_list` re-renders. There is deliberately **no**
`model→widget` IPC message; that path does not exist by construction.

### 3.6 Timers (Rust-owned countdown; SPEC §9.7)

| Message | `type` | Direction | Payload | Ordering / Idempotency |
|---|---|---|---|---|
| Control | `timer/control` | UI→core | `{ timer_id, action:"pause"\|"resume"\|"reset" }` → `TimerSnapshot` | UI-first only; **never** model-callable (no product reason for the agent to pause a user's timer). Idempotent by `request_id`. |
| Tick | `timer/tick` | core→UI | `{ timer_id, remaining_sec }` | ~1 Hz. Lossy-tolerant: carries absolute `remaining_sec`, so a dropped tick self-heals. Not idempotency-critical. |
| Updated | `timer/updated` | core→UI | `TimerSnapshot` | Full state (`{ timer_id, label, duration_sec, remaining_sec, running }`). **Idempotent** — supersedes ticks; emitted on any control action. |
| Finished | `timer/finished` | core→UI | `{ timer_id, label }` | Fires the OS notification + sound even when backgrounded (§9.7). Also drives a `bus/transcript_append` system line. Exactly once per timer completion. |

Starting a timer is the one model-callable timer action: it goes through `tool/call`/`inference/*` as
the `start_timer` tool. Pause/resume/reset are widget-lifecycle controls reached only via `timer/control`,
but they still cross IPC because the core stays the single countdown source of truth (a suspended
webview cannot be trusted to keep time — SPEC §2 responsibility split, §9.7).

### 3.7 Skills, licensing & verify (SPEC §8.8; BACKEND-DESIGN §4.4/§4.5)

| Message | `type` | Direction | Payload | Ordering / Idempotency |
|---|---|---|---|---|
| Install | `skill/install` | UI→core | `{ skill_id, version, package_path }` → `SkillInstallResult` | The core **verifies the Ed25519 signature offline** before install; rejects `signature_invalid`/`min_app_version`. Idempotent (re-install of same sha256 is a no-op success). |
| Enable | `skill/enable` | UI→core | `{ agent_id, skill_id }` → `SkillEnableResult` | Rejects `skill_locked` for an unentitled paid skill; enabling an already-enabled skill is a no-op. |
| Disable | `skill/disable` | UI→core | `{ agent_id, skill_id }` → `void` | Idempotent. Triggers a recompose (`agent/composed`). |

**`SkillInstallResult`** carries only the **public** manifest projection (id, version, category, panels
summary, tools summary, capabilities, `compressed_prompt`, `min_widget_version`, `cost_estimate`) —
**never the full `system_prompt`** (IP; §2, BACKEND-DESIGN §3.2/§4.2). Enable/disable re-run the
Orchestrator, so their effect is delivered as a fresh `MergeResult` on `agent/composed`. The
`skill_locked` rejection is what the webview renders as the locked state before an unlock code is
redeemed.

### 3.8 Notifications, telemetry, hardware

| Message | `type` | Direction | Payload | Ordering / Idempotency |
|---|---|---|---|---|
| Notify | `notify` | UI→core | `{ title, body, sound }` → `void` | Best-effort; degrades to in-app alert if OS permission denied (§9.7). Not idempotent (each call = one notification). |
| Telemetry | `telemetry/log` | UI→core | `TelemetryEvent` (versioned) → `void` | Append-only JSONL sink. The core validates `schema_version` and appends; keyed `(session_id, ts_ms, event)`. |
| Hardware | `hardware/profile` | UI→core | `void` → `HardwareProfile` | Read-only; **never gates a feature** (informs the capacity meter only). Idempotent. |

`TelemetryEvent` keeps the Phase-0 shared, versioned schema (one schema for both the app log and the
eval harness so recordings and eval runs stay comparable). `TELEMETRY_SCHEMA_VERSION` bumps on any
breaking change. The core stays deliberately untyped on the receiving side (a `Value` sink validated
on `schema_version`) so the two sides need not release in lockstep on a new event field.

### Errors — `CmdError` (command reject values)

Every command rejects with a serialized `CmdError { code, message }`. Codes:

| Code | Raised by | Meaning |
|---|---|---|
| `unknown_tool` | `tool/call` | Tool not in the active merged catalog. |
| `invalid_args` | `tool/call`, `bus/state_write` | Args/patch failed the schema for the tool/slot. |
| `execution_error` | `tool/call` | Tool ran but failed (e.g., invalid unit) — model must acknowledge. |
| `unknown_timer` | `timer/control` | No such timer. |
| `turn_in_flight` | `inference/start` | A turn is already running for the session. |
| `stale_version` | `bus/state_write` | Optimistic-concurrency miss → webview must re-snapshot. |
| `not_writer_of_record` | `bus/state_write` | Widget's skill doesn't own the slot; edit is read-only. |
| `skill_locked` | `skill/enable` | Paid skill enabled before an unlock code was redeemed. |
| `signature_invalid` | `skill/install` | `.hpskill` failed offline Ed25519 verification (SPEC §8.8). |
| `incompatible` | `agent/compose` | Delivered as `agent/compose_blocked` (conflict / slot-schema / tier). |
| `io` | any | Filesystem/OS error. |

---

## 4. The four-direction bus, on one page (SPEC §9.3)

The task frames the bus as four mechanisms; SPEC §9.3 numbers four directions. They are the same bus,
below with the exact IPC messages that carry each:

| SPEC §9.3 direction | Task framing | IPC message(s) | Auto-inference? |
|---|---|---|---|
| **1. Widget ↔ shared-state slot (two-way)** | UI ↔ shared-state | `bus/state_write` (UI→core, writer-of-record only) · `bus/state_snapshot` / `bus/state_patch` (core→UI re-render) | n/a |
| **2. Widget → tool (action)** | (UI-first path, §8.4) | `tool/call` `source:"ui"` | No (deterministic, no model) |
| **3. Tool / model → widget (update)** | model→UI via **tools/slots only** | `tool/call` result `routing` + `inference/tool_result` → `bus/state_patch` → bound widgets re-render | No |
| **4. Widget event → conversation** | UI→model via **`to_chat`**, *without auto-inference* | `bus/event` (`to_chat`) → `bus/transcript_append` (+ `notify` if time-critical) | **No — model replies only on the next user turn** |

The two guarantees that keep this predictable:

- **model→UI is tools/slots only.** No IPC message lets the model emit widgets or UI directives; it
  reads slots as context and writes them via tools (§3.5, Model↔UI bridge).
- **UI→model never auto-runs inference.** `to_chat` appends to the transcript and may fire a
  notification, but the model responds only when the user sends the next turn — no background wake,
  no drain on a backgrounded app (§3.5).

---

## 5. Versioning & drift control

- **One schema, generated bindings.** Phase 0 hand-wrote the contract twice (TS + Rust) and warned it
  would drift — it already did in the backend (`devices.register` vs `device.register`). Phase 1
  makes `ipc-messages.schema.json` the **single source**: the Rust `serde` structs and the Angular
  types are generated/validated from it, and the certification harness validates recorded traces
  against it. Do not hand-edit one side.
- **Protocol version `v`.** Additive changes (new message `type`, new optional field) keep `v:1`.
  Removing/retyping a field or changing a `type`'s required set bumps `v`; the core advertises `v` in
  `ipc/ready` and refuses a mismatched webview.
- **Skill-shipped arg/slot schemas are validated at runtime, not here.** Tool `args`, slot `value`,
  and widget `props`/`state` are typed by JSON Schemas that ship inside each signed `.hpskill` and are
  applied by the core at load. This envelope schema types the *transport* (which slots/tools/widgets
  exist, how routing and versioning work); the per-skill payload shapes are validated against the
  package's own schemas. That is the deliberate Phase-1 move the P0 seed anticipated: "expect the arg
  schema to move from compile-time types to a validated JSON Schema shipped with each skill."
