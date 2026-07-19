/* =============================================================================
   HYDROPARK — EVENT + STATE BUS, TYPED CONTRACT  (P1-06.2 · SPEC §9.3)
   -----------------------------------------------------------------------------
   The type surface of the per-agent "event + state bus" (SPEC §9.3): the
   BusEvent union, the shared-state slot model, the tool→slot→widget routing
   shape, the transcript/widget-update projections, and the injectable SEAMS the
   bus talks to the outside world through (so it hard-depends on NO concrete
   widget and NO concrete IPC transport — see bus.service.ts).

   This mirrors the production bus contract in `contracts/ipc/ipc-contract.md`
   §3.4 (routing), §3.5 (the four-direction bus) and §4 (the four directions on
   one page). It intentionally re-declares the small handful of shapes it needs
   (`SlotOp`, `ToolCallSource`, the routing directive) rather than importing the
   Phase-0 seed in `../../ipc/contract.ts`, because the Phase-0 seed predates the
   bus (it has three fixed tools and four fixed widgets, no shared-state bus —
   see the contract's "Supersedes" note) and the bus must stay general over the
   Phase-1 dynamic-tool / ~12-widget world.

   Nothing here imports Angular except `InjectionToken` (the seam tokens); the
   event/data types are plain and framework-free, so the routing logic in
   `bus.routing.ts` is unit-testable without Angular.
   ============================================================================= */

import { InjectionToken } from '@angular/core';

// ---------------------------------------------------------------------------
// Shared-state slots (SPEC §8.3.4, contract §3.5)
// ---------------------------------------------------------------------------

/** Slot value shape. Mirrors the merge layer's `{ slot, kind, … }` (contract §3.2). */
export type SlotKind = 'scalar' | 'list' | 'record';

/**
 * Mutation ops a patch/write can carry (contract §3.5 `StatePatch.op`):
 *  - `set`     — replace the whole value; scalars, or a destructive record/list
 *                replacement (writer-of-record only);
 *  - `append`  — add list entries not already present by `id` (cross-skill
 *                commutative — see contract §3.5 arbitration);
 *  - `patch`   — merge fields into existing list entries (by `id`) or a record;
 *  - `remove`  — drop list entries by `id`.
 */
export type SlotOp = 'set' | 'append' | 'patch' | 'remove';

/** A list/record entry — always keyed by a stable `id` so ops stay order-independent. */
export interface SlotEntry {
  id: string;
  [field: string]: unknown;
}

/** A slot's value: a scalar, a list of entries, or a keyed record. */
export type SlotValue = unknown;

/**
 * Static, per-slot metadata from the composed agent (`MergeResult.slots`,
 * contract §3.2). Version is deliberately NOT here — it is live state and lives
 * only on {@link SlotState} — so there is one source of truth for a slot's
 * version and no drift.
 */
export interface SlotDescriptor {
  slot: string;
  kind: SlotKind;
  /** `read` binds read-only; `read_write` is the two-way binding surface (SPEC §8.3.4). */
  access: 'read' | 'read_write';
  /** The single skill allowed to `set`/destructively mutate this slot (SPEC §8.3.4). */
  writerOfRecord: string;
}

/** Live slot state: the value the bound widgets render, version-stamped. */
export interface SlotState {
  slot: string;
  kind: SlotKind;
  value: SlotValue;
  /** Monotonic per slot; every accepted mutation increments it by exactly 1 (contract §1.3). */
  version: number;
  writerOfRecord: string;
}

/** What caused a state patch — for the transcript/telemetry, never for routing. */
export type PatchCause =
  | { kind: 'tool'; requestId?: string }
  | { kind: 'model'; turnId?: string }
  | { kind: 'ui'; requestId?: string };

/**
 * A delta on one slot (contract §3.5 `bus/state_patch`). The core computes slot
 * values; the bus only applies the resulting patch (optimistic concurrency by
 * `baseVersion`). `version = baseVersion + 1` when the core stamps it.
 */
export interface StatePatch {
  slot: string;
  op: SlotOp;
  /** The version the writer observed; the patch applies iff it matches the live version. */
  baseVersion?: number;
  /** The post-op version the core assigned; when absent the store increments locally. */
  version?: number;
  entries?: readonly SlotEntry[];
  value?: SlotValue;
  cause?: PatchCause;
}

// ---------------------------------------------------------------------------
// Tool → slot → widget routing (SPEC §9.3 last ¶, contract §3.4)
// ---------------------------------------------------------------------------

/** Who triggered a tool call — the load-bearing field for the model↔UI guard. */
export type ToolCallSource = 'ui' | 'model';

/** The closed set of places a tool/model result can land. NB: none of these is "markup". */
export type RouteKind = 'state' | 'widget' | 'chat';

/**
 * A tool ref's TRUSTED, manifest-declared routing metadata (SPEC §9.3: "this
 * explicit declaration — not name-guessing — is the binding"). It is declared
 * in the signed skill manifest and is NEVER model-controlled: the model can
 * only supply a tool's *args*, never rewire where its result goes.
 */
export interface ToolRoutingDecl {
  /** Slots this tool mutates → `route: 'state'`. */
  writes_state?: readonly string[];
  /** Slots this tool reads as context. Advisory only — does NOT affect routing. */
  reads_state?: readonly string[];
  /** The one widget a non-state-writing result is handed to → `route: 'widget'`. */
  updates_widget?: string | null;
}

/**
 * The resolved routing directive — the COMPLETE set of ways a tool/model result
 * can affect the UI. Deliberately three declarative outcomes and nothing more:
 *  - `state`  — named slots changed; bound widgets re-render (SPEC §9.3 #1 read side);
 *  - `widget` — a typed result value is handed to a widget *by id* (the widget
 *               owns how it renders — the result is data, never markup);
 *  - `chat`   — the result routes to the transcript as a system line.
 *
 * There is no `route: 'html' | 'template' | 'directive'`. That absence is the
 * model↔UI bridge (SPEC §9.3): a model result reaches the UI only as state, a
 * widget-targeted value, or chat text — never as UI code. See bus.routing.ts.
 */
export type RoutingDirective =
  | { route: 'state'; slots: readonly string[] }
  | { route: 'widget'; widget: string }
  | { route: 'chat' };

// ---------------------------------------------------------------------------
// Projections the bus exposes to widgets (read side, SPEC §9.3 #2/#3/#4)
// ---------------------------------------------------------------------------

/**
 * A transcript line appended by the bus. `kind` is fixed `'system'`: the bus
 * only ever appends system lines (a `to_chat` widget event, or a chat-routed
 * tool result). Model prose is NOT a bus concern — it streams over inference,
 * not here.
 */
export interface TranscriptLine {
  id: string;
  kind: 'system';
  text: string;
  sourceWidgetId?: string;
  /** True when a time-critical event also fired an OS notification (SPEC §9.7). */
  notified?: boolean;
  ts: number;
}

/** A result handed to one widget via `route: 'widget'` (SPEC §9.3 #3). Data, never markup. */
export interface WidgetUpdate {
  widgetId: string;
  tool: string;
  result: unknown;
  ts: number;
}

// ---------------------------------------------------------------------------
// The BusEvent union — the four dispatchable directions (SPEC §9.3)
// ---------------------------------------------------------------------------
//
// One discriminated union over `dir`, one member per binding direction. The
// discriminants encode the model↔UI guard structurally (see the `_Assert…`
// block below): only ONE member (`tool->widget`) can carry `source: 'model'`,
// and its effect is a RoutingDirective (state|widget|chat) — never UI code.

/**
 * Direction 1 — widget → shared-state (SPEC §9.3 #1, write side). A widget
 * writes a slot value. Intrinsically UI-origin: there is no `source` field, so a
 * model can NOT put a `widget->state` event on the bus. (A model changes a slot
 * only by calling a tool that declares `writes_state` — a `tool->widget` event.)
 */
export interface WidgetStateWrite {
  dir: 'widget->state';
  widgetId: string;
  /** The owning skill of the writing widget — checked against the slot's writer-of-record. */
  skillId: string;
  slot: string;
  op: SlotOp;
  /** The version the widget last saw (optimistic concurrency, contract §1.3). */
  baseVersion: number;
  entries?: readonly SlotEntry[];
  value?: SlotValue;
  requestId?: string;
}

/**
 * Direction 3 (task framing) — widget → tool, the UI-first invoke path
 * (SPEC §9.3 #2, §8.4). `source` is the LITERAL `'ui'`: a widget action never
 * routes through the model. (Model tool calls do not enter here at all — the
 * core parses them from the constrained stream and surfaces the result as a
 * `tool->widget` event; contract §3.4.)
 */
export interface WidgetToolInvoke {
  dir: 'widget->tool';
  widgetId: string;
  tool: string;
  args: unknown;
  source: 'ui';
  requestId?: string;
}

/**
 * Direction 4 (task framing) — tool / model → widget via ROUTING (SPEC §9.3 #3,
 * last ¶). The ONLY member that may carry `source: 'model'`. Its effect is fully
 * determined by `routing` (a trusted, manifest-declared {@link ToolRoutingDecl})
 * → a {@link RoutingDirective}. `statePatches` carries the already-computed slot
 * deltas the core produced for a `writes_state` result, so the bus applies state
 * without ever guessing tool-specific value shapes.
 */
export interface ToolResultEvent {
  dir: 'tool->widget';
  tool: string;
  result: unknown;
  routing: ToolRoutingDecl;
  source: ToolCallSource;
  /** For `route: 'state'` — the core-computed slot deltas to apply. */
  statePatches?: readonly StatePatch[];
  /** For `route: 'chat'` — an optional preformatted system line; else one is built from `result`. */
  line?: string;
  requestId?: string;
}

/**
 * §9.3 #4 — widget event → conversation. Each event carries a `to_chat` flag
 * (a per-widget-type default, overridable per event). A `to_chat` event appends
 * a system line to the transcript and, if `time_critical`, fires the OS
 * notification (SPEC §9.7). It NEVER auto-runs inference (the model replies only
 * on the next user turn) — and structurally cannot, because the bus holds no
 * inference seam at all. Intrinsically UI-origin (no `source` field).
 */
export interface WidgetConversationEvent {
  dir: 'widget->chat';
  widgetId: string;
  eventName: string;
  to_chat: boolean;
  time_critical?: boolean;
  /** The system line to append; when omitted one is built from `widgetId`/`eventName`. */
  line?: string;
  payload?: unknown;
}

/** The full bus event union — every mechanism dynamism flows through (SPEC §9.3). */
export type BusEvent = WidgetStateWrite | WidgetToolInvoke | ToolResultEvent | WidgetConversationEvent;

// ---------------------------------------------------------------------------
// Model↔UI bridge — enforced at COMPILE TIME (SPEC §9.3, contract §2/§4)
// ---------------------------------------------------------------------------
//
// The rule: "the model can change the UI ONLY by calling tools or writing
// shared-state slots — it never emits UI code or directives." We make that
// structurally true, not just documented:
//
//   (a) No BusEvent member carries a markup/UI-directive field. The only paths
//       to a widget are RoutingDirective's three DATA outcomes (state | widget |
//       chat). There is intentionally no `model->widget` member and no
//       `route: 'html'`.
//   (b) Every widget-origin member (`widget->state`, `widget->tool`,
//       `widget->chat`) EXCLUDES `source: 'model'` — asserted below. So the sole
//       way a model reaches the UI is a `tool->widget` event, i.e. a routed tool
//       result. If a future edit leaks `source: 'model'` onto a widget-origin
//       member (or adds a model-origin UI member), this file stops compiling.

type Assert<T extends true> = T;
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

/** Widget-origin events — the members that must never be model-sourced. */
type WidgetOriginEvent = WidgetStateWrite | WidgetToolInvoke | WidgetConversationEvent;

/**
 * PROOF: no widget-origin event can be `source: 'model'`. Since these three are
 * the only non-`tool->widget` members, the single model-reachable member is the
 * routed tool result — whose effect is a {@link RoutingDirective}, never markup.
 */
export type _ModelNeverForgesWidgetOrigin =
  Assert<Equals<Extract<WidgetOriginEvent, { source: 'model' }>, never>>;

/** PROOF: the routing outcomes stay the closed, markup-free set {state, widget, chat}. */
export type _RoutesStayClosed = Assert<Equals<RoutingDirective['route'], RouteKind>>;

// ---------------------------------------------------------------------------
// Seams — the ports the bus reaches the outside world through (optional DI)
// ---------------------------------------------------------------------------
//
// All four are OPTIONAL injection tokens. Absent, the bus still works fully in a
// self-contained, in-memory mode (writes apply to the local signal store; the
// transcript updates its own signal) — which is exactly what makes it testable
// with no Rust, no IPC, and no concrete widget. The app wires them at the
// agent-shell provider level to the real IPC transport (`tool/call`,
// `bus/state_write`, `bus/transcript_append`, `notify`).

/** Direction 3 backing — executes a UI-first tool call (crosses IPC as `tool/call`). */
export interface ToolInvocation {
  tool: string;
  args: unknown;
  source: 'ui';
  requestId: string;
}

/** The outcome the invoker returns — mirrors `ToolCallResponse` + its `routing` (contract §3.4). */
export interface ToolOutcome {
  ok: boolean;
  tool: string;
  result?: unknown;
  routing?: ToolRoutingDecl;
  /** Core-computed slot deltas for a `writes_state` result, applied via the store. */
  statePatches?: readonly StatePatch[];
  error?: { code: string; message: string };
}

export interface BusToolInvoker {
  invoke(call: ToolInvocation): Promise<ToolOutcome>;
}

/** Direction 1 backing — a writer-of-record slot write (crosses IPC as `bus/state_write`). */
export interface StateWriteRequest {
  slot: string;
  op: SlotOp;
  baseVersion: number;
  entries?: readonly SlotEntry[];
  value?: SlotValue;
  skillId: string;
  widgetId: string;
  requestId: string;
}

export interface StateWriteAck {
  ok: boolean;
  slot: string;
  /** The authoritative patch the core echoes back to apply to the local store. */
  patch?: StatePatch;
  error?: { code: string; message: string };
}

export interface BusStateWriter {
  write(req: StateWriteRequest): Promise<StateWriteAck>;
}

/** to_chat backing — bridges the bus's system lines to a host transcript (e.g. SessionService). */
export interface BusTranscriptSink {
  append(line: TranscriptLine): void;
}

/** Time-critical backing — the OS notification for a `time_critical` widget event (SPEC §9.7). */
export interface BusNotifier {
  notify(opts: { title: string; body: string; sound: boolean }): void;
}

export const BUS_TOOL_INVOKER = new InjectionToken<BusToolInvoker>('BUS_TOOL_INVOKER');
export const BUS_STATE_WRITER = new InjectionToken<BusStateWriter>('BUS_STATE_WRITER');
export const BUS_TRANSCRIPT_SINK = new InjectionToken<BusTranscriptSink>('BUS_TRANSCRIPT_SINK');
export const BUS_NOTIFIER = new InjectionToken<BusNotifier>('BUS_NOTIFIER');

// ---------------------------------------------------------------------------
// Outcome types the bus methods return (all typed, for testable assertions)
// ---------------------------------------------------------------------------

/** Rejection reasons for a slot write (contract §3.5 / Errors table). */
export type WriteRejectionCode = 'unknown_slot' | 'not_writer_of_record' | 'stale_version';

export type WriteCheck =
  | { ok: true }
  | { ok: false; code: 'unknown_slot'; message: string }
  | { ok: false; code: 'not_writer_of_record'; message: string; owner: string }
  | { ok: false; code: 'stale_version'; message: string; currentVersion: number };

export type WriteOutcome =
  | { ok: true; slot: string; version: number }
  | { ok: false; code: WriteRejectionCode | 'execution_error'; message: string };

export type InvokeOutcome =
  | { ok: true; tool: string; result: unknown; routing: RoutingDirective }
  | { ok: false; tool: string; code: string; message: string };

export interface ChatOutcome {
  appended: boolean;
  notified: boolean;
  line: TranscriptLine | null;
}

/** The unified return of {@link BusService.dispatch}, discriminated by direction. */
export type DispatchResult =
  | { dir: 'widget->state'; write: WriteOutcome }
  | { dir: 'widget->tool'; invoke: InvokeOutcome }
  | { dir: 'tool->widget'; routing: RoutingDirective }
  | { dir: 'widget->chat'; chat: ChatOutcome };
