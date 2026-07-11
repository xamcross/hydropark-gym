/* =============================================================================
   HYDROPARK — EVENT + STATE BUS, PURE ROUTING CORE  (P1-06.2 · SPEC §9.3)
   -----------------------------------------------------------------------------
   The routing + arbitration + slot-mutation rules of the bus, expressed as
   SIDE-EFFECT-FREE functions over plain data. Nothing here imports Angular, so
   the whole routing algorithm is unit-testable WITHOUT Karma/Jasmine — assert on
   the return values directly.

   `BusService` (./bus.service.ts) is the thin stateful shell that holds the slot
   signals + transcript in signals and calls into these functions. This mirrors
   the layout engine's split (`layout.model.ts` pure ↔ `layout.service.ts`
   stateful).

   Implements:
     - routeToolResult   — SPEC §9.3 last ¶ / contract §3.4 routing precedence;
     - checkSlotWrite    — SPEC §8.3.4 writer-of-record + optimistic concurrency;
     - applySlotOp       — contract §3.5 append/patch/remove/set semantics;
     - transcript-line builders for `to_chat` + chat-routed results.
   ============================================================================= */

import {
  RoutingDirective,
  SlotDescriptor,
  SlotEntry,
  SlotKind,
  SlotOp,
  SlotValue,
  ToolResultEvent,
  ToolRoutingDecl,
  TranscriptLine,
  WidgetConversationEvent,
  WriteCheck,
} from './bus.contract';

// ---------------------------------------------------------------------------
// Routing (SPEC §9.3 last ¶, contract §3.4)
// ---------------------------------------------------------------------------

/**
 * Resolve a tool ref's TRUSTED routing declaration to a {@link RoutingDirective}.
 * Precedence (contract §3.4 table), keyed on slot NAME so it is unambiguous when
 * a tool is shared or namespaced across skills:
 *   1. declares `writes_state` (non-empty) → `state`  (bound widgets re-render);
 *   2. else declares `updates_widget`      → `widget` (result handed to one widget);
 *   3. else                                → `chat`   (result posts to transcript).
 *
 * This is a TOTAL function over the three markup-free outcomes — the structural
 * heart of the model↔UI bridge (SPEC §9.3): the model supplies a tool's args,
 * but the *route* comes from the signed manifest, and the outcome can only ever
 * be state / widget / chat, never UI code.
 *
 * INVARIANT: the returned `route` is always one of 'state' | 'widget' | 'chat';
 * there is no input by which it could become anything else.
 */
export function routeToolResult(decl: ToolRoutingDecl): RoutingDirective {
  if (decl.writes_state && decl.writes_state.length > 0) {
    return { route: 'state', slots: [...decl.writes_state] };
  }
  if (decl.updates_widget) {
    return { route: 'widget', widget: decl.updates_widget };
  }
  return { route: 'chat' };
}

// ---------------------------------------------------------------------------
// Writer-of-record + optimistic concurrency (SPEC §8.3.4, contract §1.3/§3.5)
// ---------------------------------------------------------------------------

/**
 * Decide whether a widget's slot write is allowed, BEFORE it mutates anything:
 *   - unknown slot                                   → `unknown_slot`;
 *   - slot not `read_write`, or a different owner    → `not_writer_of_record`
 *     (SPEC §8.3.4: a widget bound to a slot its skill does not own is
 *      read-only — it renders live patches but its edit affordances are disabled);
 *   - `baseVersion` ≠ live version                   → `stale_version`
 *     (optimistic concurrency; the caller re-snapshots and retries).
 *
 * Pure: takes the live `currentVersion` explicitly rather than reading state.
 */
export function checkSlotWrite(
  desc: SlotDescriptor | undefined,
  currentVersion: number,
  write: { skillId: string; baseVersion: number }
): WriteCheck {
  if (!desc) {
    return { ok: false, code: 'unknown_slot', message: 'no such slot' };
  }
  if (desc.access !== 'read_write' || desc.writerOfRecord !== write.skillId) {
    return {
      ok: false,
      code: 'not_writer_of_record',
      message: `slot "${desc.slot}" is owned by "${desc.writerOfRecord}"`,
      owner: desc.writerOfRecord,
    };
  }
  if (write.baseVersion !== currentVersion) {
    return {
      ok: false,
      code: 'stale_version',
      message: `stale write: expected version ${currentVersion}, got ${write.baseVersion}`,
      currentVersion,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Slot mutation (contract §3.5 StatePatch semantics)
// ---------------------------------------------------------------------------

function asList(v: SlotValue): SlotEntry[] {
  return Array.isArray(v) ? (v as SlotEntry[]) : [];
}

function asRecord(v: SlotValue): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {};
}

/**
 * Apply one op to a slot's current value and return the NEW value (never mutates
 * the input). Op semantics (contract §3.5), all commutative by entry `id` where
 * they touch lists so concurrent cross-skill contributions converge:
 *   - `set`    → replace with `delta.value`;
 *   - `append` → add `delta.entries` whose `id` is not already present;
 *   - `patch`  → merge fields into matching list entries by `id`, or (record)
 *                shallow-merge `delta.value` into the record;
 *   - `remove` → drop list entries whose `id` is in `delta.entries`.
 */
export function applySlotOp(
  kind: SlotKind,
  current: SlotValue,
  op: SlotOp,
  delta: { entries?: readonly SlotEntry[]; value?: SlotValue }
): SlotValue {
  switch (op) {
    case 'set':
      return delta.value;

    case 'append': {
      const list = asList(current);
      const have = new Set(list.map((e) => e.id));
      const add = (delta.entries ?? []).filter((e) => !have.has(e.id));
      return [...list, ...add];
    }

    case 'patch': {
      if (kind === 'record') {
        return { ...asRecord(current), ...asRecord(delta.value) };
      }
      const patchById = new Map((delta.entries ?? []).map((e) => [e.id, e]));
      return asList(current).map((e) => (patchById.has(e.id) ? { ...e, ...patchById.get(e.id)! } : e));
    }

    case 'remove': {
      const drop = new Set((delta.entries ?? []).map((e) => e.id));
      return asList(current).filter((e) => !drop.has(e.id));
    }
  }
}

/** The empty value for a freshly-registered slot of `kind` (scalar→undefined, list→[], record→{}). */
export function emptyValueFor(kind: SlotKind): SlotValue {
  switch (kind) {
    case 'list':
      return [];
    case 'record':
      return {};
    case 'scalar':
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Transcript-line builders (SPEC §9.3 #4 / §9.7, contract §3.5)
// ---------------------------------------------------------------------------

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `bus_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

/**
 * Build the system transcript line for a `to_chat` widget event (SPEC §9.3 #4).
 * Uses the event's explicit `line` when given, else a terse default. `notified`
 * records whether it also fired an OS notification (time-critical, SPEC §9.7).
 */
export function widgetEventLine(e: WidgetConversationEvent, notified: boolean): TranscriptLine {
  return {
    id: newId(),
    kind: 'system',
    text: e.line ?? `${e.widgetId}: ${e.eventName}`,
    sourceWidgetId: e.widgetId,
    notified,
    ts: Date.now(),
  };
}

/** Build the system line for a chat-routed tool result (`route: 'chat'`, contract §3.4). */
export function toolResultLine(e: ToolResultEvent): TranscriptLine {
  return {
    id: newId(),
    kind: 'system',
    text: e.line ?? `${e.tool}: ${formatResult(e.result)}`,
    ts: Date.now(),
  };
}

function formatResult(result: unknown): string {
  if (result == null) return 'done';
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}
