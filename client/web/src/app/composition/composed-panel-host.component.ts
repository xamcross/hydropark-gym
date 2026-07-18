/* =============================================================================
   HYDROPARK — COMPOSED PANEL HOST  (P1 live-flow wiring · SPEC §9.3/§9.6)
   -----------------------------------------------------------------------------
   The INSPECTOR surface of a composed agent — summary, capacity/context gate
   outcome, assembled persona, and composed tool set. It:
     1. registers the composed agent's shared-state SLOTS on a per-agent
        BusService and DRIVES tool→widget updates through that bus per the
        composed view's routing (a `writes_state` result patches slots; an
        `updates_widget` result lands in that widget's inbox; else it posts to
        chat);
     2. animates the inspector body in/out with the reduce-motion-aware
        `appPanelTransition` directive (SPEC §9.6 / §8.6).

   NOTE (W04 de-dup): this component used to ALSO mount the live interactive
   panels (timers/ingredients/units) here via a nested `LayoutDockComponent` +
   the widget registry (NgComponentOutlet), bound to this bus's slots, wrapped
   in the reduce-motion-aware `appPanelTransition` directive. That was a
   SECOND, independent rendering of the exact same widget types already
   mounted — self-sourced, directly against `SessionService`/`ToolsService` —
   in the main dock (`app.component.html`'s `app-panel-dock`, which owns ITS
   OWN transform-animated mount/unmount and is untouched by this fix). The two
   never stayed in sync: UI-first interactions (add an ingredient, start a
   timer) go straight through `ToolsService` to `SessionService`, NOT through
   this bus — the bus's slots only update via `routeToolResult` below, which
   only fires on an `inference://tool_call_result` event. So the copy mounted
   here rendered permanently empty ("ingredients 0 item(s)", a nested empty
   "Ingredients" panel) next to the real, populated main dock. The main dock
   is the single authoritative, interactive panel surface; this component
   stays a compact inspector (gated only by `composed()`, same as before) and
   never mounts those widgets. The bus/routing plumbing itself is untouched —
   only the duplicate RENDERING was removed.
   ============================================================================= */

import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { IPC_PORT } from '../ipc/ipc.port';
import { BUS_TRANSCRIPT_SINK, BusService, BusTranscriptSink, StatePatch, TranscriptLine } from '../shared/bus';
import { SessionService } from '../state/session.service';
import { SaveTemplateDialogComponent } from '../templates/save-template-dialog.component';
import { CompositionService } from './composition.service';

@Component({
  selector: 'app-composed-panel-host',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SaveTemplateDialogComponent],
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

  /** "Save as template" dialog visibility (Task 11b). */
  readonly saveDialogOpen = signal(false);

  // Surfaced straight to the template (all signals).
  readonly composed = this.composition.composed;
  readonly error = this.composition.error;
  readonly composing = this.composition.composing;
  readonly hasAgent = this.composition.hasAgent;

  /** A short, safe preview of the composed persona (never the full paid prompt). */
  readonly personaPreview = computed<string>(() => {
    const p = this.composed()?.persona ?? '';
    return p.length > 280 ? `${p.slice(0, 280)}…` : p;
  });

  constructor() {
    // Keep the bus's slot table in step with the composed agent (still feeds
    // tool→state routing below, even though no widget here reads a slot).
    effect(() => this.bus.registerSlots(this.composition.slots()));

    // Route already-executed tool results through the bus per the composed
    // routing. In the P0 mock these arrive on `inference://tool_call_result`;
    // in the Tauri build the core emits the same event after it runs the tool.
    const off = this.ipc.on('inference://tool_call_result', (e) =>
      this.routeToolResult(e.tool, e.result)
    );

    inject(DestroyRef).onDestroy(off);
  }

  // --- save-as-template dialog (Task 11b) -----------------------------------

  openSaveDialog(): void {
    this.saveDialogOpen.set(true);
  }

  closeSaveDialog(): void {
    this.saveDialogOpen.set(false);
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
