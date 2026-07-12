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
import { BusService, StatePatch } from '../shared/bus';
import { ArrangedPanel } from '../shared/layout/layout.model';
import { LayoutDockComponent, PanelBodyDirective } from '../shared/layout/layout-dock.component';
import { PanelTransitionDirective } from '../shared/panel-transition/panel-transition.directive';
import { CompositionService } from './composition.service';
import { ResolvedWidget, resolveWidget } from './widget-registry';

@Component({
  selector: 'app-composed-panel-host',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgComponentOutlet, LayoutDockComponent, PanelBodyDirective, PanelTransitionDirective],
  templateUrl: './composed-panel-host.component.html',
  styleUrl: './composed-panel-host.component.css',
  providers: [BusService],
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
   */
  resolve(panel: ArrangedPanel): ResolvedWidget {
    return resolveWidget(panel);
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
