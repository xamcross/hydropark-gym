/* =============================================================================
   HYDROPARK — COMPOSED PANEL HOST  (P1 live-flow wiring · SPEC §9.3/§9.5/§9.6)
   -----------------------------------------------------------------------------
   The live surface of a composed agent. It:
     1. reads the enabled skills' panel declarations (via CompositionService) and
        renders them through the LAYOUT-DOCK (place-by-region-then-priority,
        dedupe, responsive fold — all owned by the dock/LayoutService);
     2. mounts the matching widget component for each panel dynamically through
        the WIDGET REGISTRY (NgComponentOutlet), which is how the previously
        unmounted library widgets become usable;
     3. registers the composed agent's shared-state SLOTS on a per-agent
        BusService and DRIVES tool→widget updates through that bus per the
        composed view's routing (a `writes_state` result patches slots; an
        `updates_widget` result lands in that widget's inbox; else it posts to
        chat);
     4. animates the panel surface in/out with the reduce-motion-aware
        `appPanelTransition` directive (SPEC §9.6 / §8.6).

   BusService is provided HERE (component scope) because SPEC §9.3 gives each
   active agent exactly one bus — not a global singleton. OnPush + signals.
   ============================================================================= */

import { NgComponentOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
} from '@angular/core';
import { IPC_PORT } from '../ipc/ipc.port';
import { BUS_TRANSCRIPT_SINK, BusService, BusTranscriptSink, StatePatch, TranscriptLine } from '../shared/bus';
import { ArrangedPanel } from '../shared/layout/layout.model';
import { LayoutDockComponent, PanelBodyDirective } from '../shared/layout/layout-dock.component';
import { PanelTransitionDirective } from '../shared/panel-transition/panel-transition.directive';
import { SessionService } from '../state/session.service';
import { BoundState } from '../widgets/widget-contract';
import { boundStateEqual, boundStateFor } from './bound-state';
import { CompositionService } from './composition.service';
import { ResolvedWidget, acceptsBoundState, isPlaceholder, resolveWidget } from './widget-registry';

@Component({
  selector: 'app-composed-panel-host',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgComponentOutlet, LayoutDockComponent, PanelBodyDirective, PanelTransitionDirective],
  templateUrl: './composed-panel-host.component.html',
  styleUrl: './composed-panel-host.component.css',
  providers: [
    BusService,
    // The `to_chat` bridge (SPEC §9.3 #4): forward every bus-appended
    // TranscriptLine into the VISIBLE chat as a `role:'system'` ChatMessage.
    // Scoped here (not root) because the bus itself is per-agent — see the
    // BusService class doc. This NEVER calls InferenceService; SessionService
    // holds no inference seam, so posting a transcript line structurally
    // cannot auto-run the model (SPEC §9.3).
    {
      provide: BUS_TRANSCRIPT_SINK,
      useFactory: (session: SessionService): BusTranscriptSink => ({
        append: (line: TranscriptLine) =>
          session.addMessage({ id: line.id, role: 'system', text: line.text, streaming: false }),
      }),
      deps: [SessionService],
    },
  ],
})
export class ComposedPanelHostComponent {
  readonly composition = inject(CompositionService);
  readonly bus = inject(BusService);
  private readonly ipc = inject(IPC_PORT);

  // Surfaced straight to the template (all signals).
  readonly composed = this.composition.composed;
  readonly error = this.composition.error;
  readonly composing = this.composition.composing;
  readonly hasAgent = this.composition.hasAgent;
  readonly panels = this.composition.panels;
  readonly slots = this.composition.slots;

  /** A short, safe preview of the composed persona (never the full paid prompt). */
  readonly personaPreview = computed<string>(() => {
    const p = this.composed()?.persona ?? '';
    return p.length > 280 ? `${p.slice(0, 280)}…` : p;
  });

  /** skillId → display name, for the bound-state "Managed by …" attribution (§5). */
  private readonly skillNames = computed<Map<string, string>>(() => {
    const map = new Map<string, string>();
    for (const m of this.composition.enabledManifests()) map.set(m.id, m.name);
    return map;
  });

  /**
   * Reference-stable cache of the per-panel bound state, keyed by `panel.key`.
   * NgComponentOutlet diffs inputs by value, and dev-mode CD checks the bound
   * input twice per tick — returning a fresh object each pass would look like a
   * change, so we hand back the SAME reference until the slot version / owner /
   * writer actually changes (see {@link boundStateEqual}).
   */
  private readonly boundCache = new Map<string, BoundState>();

  constructor() {
    // (3a) Keep the bus's slot table in step with the composed agent.
    effect(() => this.bus.registerSlots(this.composition.slots()));

    // (3b) Route already-executed tool results through the bus per the composed
    // routing. In the P0 mock these arrive on `inference://tool_call_result`;
    // in the Tauri build the core emits the same event after it runs the tool.
    const off = this.ipc.on('inference://tool_call_result', (e) =>
      this.routeToolResult(e.tool, e.result)
    );
    inject(DestroyRef).onDestroy(off);
  }

  // --- dynamic mount (widget registry) -------------------------------------

  /**
   * Resolve a panel to the component + inputs the outlet mounts. Unknown or
   * too-new widget types resolve to a graceful PLACEHOLDER (never `null`), so a
   * single unrenderable panel can't blank the composed agent (SPEC §9.8).
   *
   * For a BOUND panel whose widget is bound-state-aware (P1-06.1), this also
   * threads the live read-only bound state in as the `bound` input — reading the
   * slot signal HERE is what keeps a non-writer widget rendering live (direction
   * #2) with edit affordances disabled + the writer named (contract §5).
   */
  resolve(panel: ArrangedPanel): ResolvedWidget {
    const base = resolveWidget(panel);
    const binding = panel.descriptor.binding;
    if (!binding || isPlaceholder(base) || !acceptsBoundState(panel.descriptor.widgetType)) {
      return base;
    }
    // Live slot read → this OnPush view re-renders (and re-resolves) on every
    // mutation of the bound slot; the memo keeps the input reference stable.
    const slot = this.bus.slot(binding)();
    const fresh = boundStateFor(panel, slot, (id) => this.displayName(id));
    const bound = this.stableBound(panel.key, fresh);
    return { component: base.component, inputs: { ...base.inputs, bound } };
  }

  /** The display name of a skill for the "Managed by …" attribution; falls back to the id. */
  private displayName(skillId: string): string {
    return this.skillNames().get(skillId) ?? skillId;
  }

  /** Return the cached bound state for `key` when equivalent, else adopt the fresh one. */
  private stableBound(key: string, fresh: BoundState): BoundState {
    const prev = this.boundCache.get(key) ?? null;
    if (boundStateEqual(prev, fresh)) return prev as BoundState;
    this.boundCache.set(key, fresh);
    return fresh;
  }

  // --- bus read side (proves tool→state routing is live) -------------------

  /** The current version of a slot (from the per-agent bus store). */
  slotVersion(name: string): number {
    return this.bus.slot(name)().version;
  }

  /** A terse, render-safe summary of a slot's live value. */
  slotSummary(name: string): string {
    const v = this.bus.slot(name)().value;
    if (v == null) return '—';
    if (Array.isArray(v)) return `${v.length} item(s)`;
    if (typeof v === 'object') return `${Object.keys(v as object).length} field(s)`;
    return String(v);
  }

  // --- direction #4: tool/model → widget, via routing ----------------------

  private routeToolResult(tool: string, result: unknown): void {
    const decl = this.composition.routingDecls().get(tool);
    if (!decl) return;

    const writes = decl.writes_state ?? [];
    const statePatches: StatePatch[] =
      writes.length > 0
        ? writes.map((slot) => ({ slot, op: 'set', value: extractSlotValue(result, slot), cause: { kind: 'tool' } }))
        : [];

    this.bus.ingestToolResult({
      dir: 'tool->widget',
      tool,
      result,
      routing: decl,
      statePatches,
      source: 'model',
    });
  }
}

/**
 * Pick the value a `writes_state` slot should receive from a tool result. Tools
 * conventionally return `{ <slot>: value, … }` (e.g. `list_manage` →
 * `{ ingredients: [...] }`), so prefer a same-named field; otherwise hand the
 * whole result to the slot. (The Rust core supplies precomputed patches in the
 * real flow; this keeps the mock/browser path working without per-tool code.)
 */
function extractSlotValue(result: unknown, slot: string): unknown {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const rec = result as Record<string, unknown>;
    if (slot in rec) return rec[slot];
  }
  return result;
}
