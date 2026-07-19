/* =============================================================================
   HYDROPARK — EVENT + STATE BUS SERVICE  (P1-06.2 · SPEC §9.3)
   -----------------------------------------------------------------------------
   The per-agent "event + state bus" (SPEC §9.3): the ONE object that mediates
   all UI dynamism for a composed agent. It ties together the shared-state signal
   store, the tool→slot→widget routing, and the transcript/notification surface,
   modelling the four binding directions:

     1. widget → shared-state   `writeSlot`            (writer-of-record gated)
     2. shared-state → widget   `slot` / `slotValue`   (observe live signals)
     3. widget → tool           `invokeTool`           (UI-first path, no model)
     4. tool/model → widget     `ingestToolResult`     (ROUTING: state|widget|chat)
     +  widget event → chat     `emitConversationEvent`(`to_chat`, NO inference)

   Decoupling: the service hard-depends on NO concrete widget and NO concrete IPC
   transport. Side effects cross four OPTIONAL seams (bus.contract.ts); absent,
   the bus runs fully in-memory (writes hit the local signal store, the
   transcript updates its own signal) — which is what makes it testable with no
   Rust and no IPC. The app provides the seams at the agent-shell level.

   Scope: NOT `providedIn: 'root'`. SPEC §9.3 is explicit — "each active agent
   has ONE event + state bus" — so the bus is provided per agent-shell component
   (like `LayoutService`), giving each agent its own store, transcript and seams
   with no global singleton to cross-contaminate a second agent.

   Model↔UI guard: this service has NO reference to any inference trigger and no
   method that runs inference — so `to_chat` (and everything else) structurally
   cannot auto-run the model. Combined with the compile-time proof in
   bus.contract.ts (`_ModelNeverForgesWidgetOrigin`), the model can reach the UI
   only as routed tool state/widget/chat — never as UI code, never as a wake.
   ============================================================================= */

import { Injectable, Signal, WritableSignal, inject, signal } from '@angular/core';
import {
  BUS_NOTIFIER,
  BUS_STATE_WRITER,
  BUS_TOOL_INVOKER,
  BUS_TRANSCRIPT_SINK,
  BusEvent,
  ChatOutcome,
  DispatchResult,
  InvokeOutcome,
  RoutingDirective,
  SlotDescriptor,
  SlotState,
  StatePatch,
  ToolResultEvent,
  TranscriptLine,
  WidgetConversationEvent,
  WidgetStateWrite,
  WidgetToolInvoke,
  WidgetUpdate,
  WriteOutcome,
} from './bus.contract';
import { routeToolResult, toolResultLine, widgetEventLine } from './bus.routing';
import { SharedStateStore } from './bus.store';

@Injectable()
export class BusService {
  /** The shared-state facade — the read side of directions #1/#2 (Map slot → signal). */
  private readonly store = new SharedStateStore();

  /** The bus's own transcript projection (system lines only — see bus.contract.ts). */
  private readonly _transcript = signal<readonly TranscriptLine[]>([]);
  readonly transcript: Signal<readonly TranscriptLine[]> = this._transcript.asReadonly();

  /** Per-widget inbox for `route: 'widget'` results (direction #3, `updates_widget`). */
  private readonly widgetInboxes = new Map<string, WritableSignal<WidgetUpdate | null>>();

  // Optional seams — absent ⇒ fully in-memory/testable (see class doc).
  private readonly toolInvoker = inject(BUS_TOOL_INVOKER, { optional: true });
  private readonly stateWriter = inject(BUS_STATE_WRITER, { optional: true });
  private readonly transcriptSink = inject(BUS_TRANSCRIPT_SINK, { optional: true });
  private readonly notifier = inject(BUS_NOTIFIER, { optional: true });

  // ── registration ──────────────────────────────────────────────────────────

  /** Register the composed agent's slot table (`MergeResult.slots`, contract §3.2). */
  registerSlots(descriptors: readonly SlotDescriptor[]): void {
    this.store.register(descriptors);
  }

  // ── direction #2: shared-state → widget (observe live signals) ─────────────

  /** The live signal for a slot (bind a widget's `binds_state` to this). */
  slot(name: string): Signal<SlotState> {
    return this.store.slot(name);
  }

  /** Derived signal of just a slot's value, typed by the caller. */
  slotValue<T = unknown>(name: string): Signal<T | undefined> {
    return this.store.value<T>(name);
  }

  /** The slot → readonly-signal map (introspection / tests). */
  slots(): ReadonlyMap<string, Signal<SlotState>> {
    return this.store.slotMap();
  }

  /** The inbox signal a widget reads for `route: 'widget'` results (null until one arrives). */
  widgetInbox(widgetId: string): Signal<WidgetUpdate | null> {
    return this.ensureInbox(widgetId).asReadonly();
  }

  // ── unified dispatch ───────────────────────────────────────────────────────

  /**
   * Route any {@link BusEvent} to its direction handler. The single entry point
   * an emitter can use instead of the typed methods below; the `dir` discriminant
   * (which structurally forbids a model-forged widget-origin event — see
   * bus.contract.ts) selects the path.
   */
  async dispatch(event: BusEvent): Promise<DispatchResult> {
    switch (event.dir) {
      case 'widget->state':
        return { dir: 'widget->state', write: await this.writeSlot(event) };
      case 'widget->tool':
        return { dir: 'widget->tool', invoke: await this.invokeTool(event) };
      case 'tool->widget':
        return { dir: 'tool->widget', routing: this.ingestToolResult(event) };
      case 'widget->chat':
        return { dir: 'widget->chat', chat: this.emitConversationEvent(event) };
      default:
        return assertNever(event);
    }
  }

  // ── direction #1: widget → shared-state ────────────────────────────────────

  /**
   * Write a slot from a widget (SPEC §9.3 #1). Gated by writer-of-record +
   * optimistic concurrency FIRST (SPEC §8.3.4) — a widget bound to a slot its
   * skill does not own is read-only and its write is rejected `not_writer_of_record`.
   *
   * With a state-writer seam wired, the write crosses IPC (`bus/state_write`) and
   * the authoritative echo patch is applied to the local store. Seam-less, the
   * store is authoritative locally so the loop closes for tests.
   */
  async writeSlot(e: WidgetStateWrite): Promise<WriteOutcome> {
    const check = this.store.checkWrite(e.slot, { skillId: e.skillId, baseVersion: e.baseVersion });
    if (!check.ok) return { ok: false, code: check.code, message: check.message };

    const requestId = e.requestId ?? newId();

    if (this.stateWriter) {
      const ack = await this.stateWriter.write({
        slot: e.slot,
        op: e.op,
        baseVersion: e.baseVersion,
        entries: e.entries,
        value: e.value,
        skillId: e.skillId,
        widgetId: e.widgetId,
        requestId,
      });
      if (!ack.ok) {
        const code = ack.error?.code;
        const known = code === 'not_writer_of_record' || code === 'stale_version' || code === 'unknown_slot';
        return { ok: false, code: known ? code : 'execution_error', message: ack.error?.message ?? 'state write rejected' };
      }
      if (ack.patch) this.store.applyPatch(ack.patch);
      return { ok: true, slot: e.slot, version: this.store.version(e.slot) };
    }

    // Standalone/local mode — apply directly (already gated above).
    const applied = this.store.applyPatch({
      slot: e.slot,
      op: e.op,
      baseVersion: e.baseVersion,
      entries: e.entries,
      value: e.value,
      cause: { kind: 'ui', requestId },
    });
    if (!applied.ok) return { ok: false, code: applied.code, message: applied.message };
    return { ok: true, slot: e.slot, version: applied.state.version };
  }

  // ── direction #3: widget → tool (UI-first, no model round-trip) ────────────

  /**
   * Invoke a tool from a widget action (SPEC §9.3 #2, §8.4 UI-first path). Always
   * `source: 'ui'` — deterministic, no model. On success the result is routed
   * back through {@link ingestToolResult} (direction #4) exactly as a model
   * result would be, so "tap the button" and "the model called it" behave
   * identically once the result lands.
   */
  async invokeTool(e: WidgetToolInvoke): Promise<InvokeOutcome> {
    if (!this.toolInvoker) {
      return { ok: false, tool: e.tool, code: 'execution_error', message: 'no tool invoker wired' };
    }
    const requestId = e.requestId ?? newId();
    const outcome = await this.toolInvoker.invoke({ tool: e.tool, args: e.args, source: 'ui', requestId });
    if (!outcome.ok) {
      return { ok: false, tool: e.tool, code: outcome.error?.code ?? 'execution_error', message: outcome.error?.message ?? 'tool failed' };
    }
    const routing = this.ingestToolResult({
      dir: 'tool->widget',
      tool: e.tool,
      result: outcome.result,
      routing: outcome.routing ?? {},
      statePatches: outcome.statePatches,
      source: 'ui',
      requestId,
    });
    return { ok: true, tool: e.tool, result: outcome.result, routing };
  }

  // ── direction #4: tool / model → widget, via ROUTING ───────────────────────

  /**
   * Route an already-executed tool result (SPEC §9.3 #3, last ¶). The route comes
   * from the tool's TRUSTED manifest declaration — `writes_state` → `state`,
   * else `updates_widget` → `widget`, else `chat`. Accepts `source: 'ui' | 'model'`
   * identically: this is the one and only path a model result reaches the UI, and
   * it can only ever land as state / a widget value / chat text — never as markup
   * (the model↔UI bridge, SPEC §9.3; proven in bus.contract.ts).
   */
  ingestToolResult(e: ToolResultEvent): RoutingDirective {
    const directive = routeToolResult(e.routing);
    switch (directive.route) {
      case 'state':
        // The core computed the concrete slot deltas; apply them so every bound
        // widget re-renders (direction #2 closes the loop). The bus never guesses
        // tool-specific value shapes.
        for (const patch of e.statePatches ?? []) {
          this.store.applyPatch(patch);
        }
        break;
      case 'widget':
        this.ensureInbox(directive.widget).set({
          widgetId: directive.widget,
          tool: e.tool,
          result: e.result,
          ts: Date.now(),
        });
        break;
      case 'chat':
        this.appendLine(toolResultLine(e));
        break;
    }
    return directive;
  }

  // ── §9.3 #4: widget event → conversation (`to_chat`, NO inference) ─────────

  /**
   * Handle a widget event (SPEC §9.3 #4). When `to_chat`, append a system line to
   * the transcript so it stays a complete record; when `time_critical`, fire the
   * OS notification (SPEC §9.7). It NEVER auto-runs inference — the model replies
   * only when the USER sends the next turn. This is guaranteed structurally: the
   * bus holds no inference seam, so there is no code path from here to the model.
   */
  emitConversationEvent(e: WidgetConversationEvent): ChatOutcome {
    let notified = false;
    if (e.time_critical && this.notifier) {
      this.notifier.notify({ title: e.eventName, body: e.line ?? e.eventName, sound: true });
      notified = true;
    }
    if (!e.to_chat) return { appended: false, notified, line: null };

    const line = widgetEventLine(e, notified);
    this.appendLine(line);
    return { appended: true, notified, line };
  }

  // ── core-pushed state (contract §3.5 `bus/state_patch` / snapshot) ─────────

  /**
   * Apply a core-authoritative state patch (from `bus/state_patch`, e.g. a model
   * tool call the core executed). Same store path direction #4 uses; exposed so
   * the IPC listener can feed patches straight in. Returns false on a stale patch.
   */
  applyStatePatch(patch: StatePatch): boolean {
    return this.store.applyPatch(patch).ok;
  }

  /** Directly append a core-pushed transcript system line (`bus/transcript_append`). */
  appendTranscriptLine(line: TranscriptLine): void {
    this.appendLine(line);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private appendLine(line: TranscriptLine): void {
    this._transcript.update((list) => [...list, line]);
    this.transcriptSink?.append(line);
  }

  private ensureInbox(widgetId: string): WritableSignal<WidgetUpdate | null> {
    let inbox = this.widgetInboxes.get(widgetId);
    if (!inbox) {
      inbox = signal<WidgetUpdate | null>(null);
      this.widgetInboxes.set(widgetId, inbox);
    }
    return inbox;
  }
}

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `bus_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

/** Exhaustiveness guard for {@link BusService.dispatch}. */
function assertNever(x: never): never {
  throw new Error(`unhandled BusEvent: ${JSON.stringify(x)}`);
}
