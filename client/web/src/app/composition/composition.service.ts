/* =============================================================================
   HYDROPARK — COMPOSITION SERVICE  (P1 live-flow wiring · SPEC §8.3)
   -----------------------------------------------------------------------------
   The webview side of the "compose the enabled skills into one live agent" flow.
   It watches the ENABLED-SKILL SET, gathers those skills' manifests, and calls
   the Rust `compose_agent` command (validate → merge → capacity gate → routing),
   exposing the resulting `ComposedAgentView` — and any structured
   `ComposeError` — as signals the compose UI renders.

   ── Hooking the existing enable/disable path ─────────────────────────────────
   Phase-0 skills are toggled through `SessionService.kitchenSkillEnabled` (the
   free skill) and `CookingAssistantService.enabled` (the paid skill). This
   service DERIVES its enabled-manifest set from those exact signals, so the
   moment the user flips a skill on/off in the existing `SkillToggle`, the agent
   re-composes — no change to the toggle component, purely additive.

   Scope: `providedIn: 'root'` — the composed agent is app-global (there is one
   active agent), unlike the per-agent BusService which the panel host provides.
   ============================================================================= */

import { Injectable, Signal, computed, effect, inject, signal } from '@angular/core';
import { IPC_PORT } from '../ipc/ipc.port';
import { ComposeError, ComposedAgentView } from '../ipc/contract';
import { SlotDescriptor, ToolRoutingDecl } from '../shared/bus';
import { PanelDescriptor } from '../shared/layout/layout.model';
import { SessionService } from '../state/session.service';
import { TelemetryService } from '../state/telemetry.service';
import { CookingAssistantService } from '../skills/cooking-assistant/cooking-assistant.service';
import { KITCHEN_TIMER_MANIFEST, COOKING_ASSISTANT_MANIFEST } from './manifest-registry';
import {
  SkillManifest,
  manifestId,
  panelsFromManifests,
  routingDeclsFrom,
  slotsFromManifests,
} from './skill-manifest';

/** Default model context window used when the caller has not measured one. */
const DEFAULT_N_CTX = 4096;

@Injectable({ providedIn: 'root' })
export class CompositionService {
  private readonly ipc = inject(IPC_PORT);
  private readonly session = inject(SessionService);
  private readonly telemetry = inject(TelemetryService);
  private readonly cooking = inject(CookingAssistantService);

  /**
   * The enabled skills' manifests, DERIVED from the existing P0 enable signals.
   * This is the "hook": toggling a skill anywhere flips its membership here.
   */
  readonly enabledManifests: Signal<readonly SkillManifest[]> = computed(() => {
    const out: SkillManifest[] = [];
    if (this.session.kitchenSkillEnabled()) out.push(KITCHEN_TIMER_MANIFEST);
    if (this.cooking.enabled()) out.push(COOKING_ASSISTANT_MANIFEST);
    return out;
  });

  readonly enabledIds = computed<string[]>(() => this.enabledManifests().map(manifestId));

  /** User's chosen lead skill (optional) — drives `primaryHint`. */
  readonly primaryHint = signal<string | null>(null);
  /** Model context window in tokens. */
  readonly nCtx = signal<number>(DEFAULT_N_CTX);

  /**
   * True when the current enabled set was adopted from a saved template rather
   * than toggled ad-hoc. Drives the `via_template` dimension of the P1-25.1
   * composition metric; the template-adoption path (P1 templates) sets it.
   */
  readonly viaTemplate = signal(false);

  /**
   * Dedupe latch for the P1-25.1 composition metric: emit once per
   * composition-active transition, not on every re-compose. Reset when the
   * agent drops back below the composition threshold.
   */
  private compositionReported = false;

  private readonly _composed = signal<ComposedAgentView | null>(null);
  /** The live composed agent, or `null` when nothing is composed / a compose failed. */
  readonly composed = this._composed.asReadonly();

  private readonly _error = signal<ComposeError | null>(null);
  /** The last structured composition failure, or `null`. */
  readonly error = this._error.asReadonly();

  private readonly _composing = signal(false);
  readonly composing = this._composing.asReadonly();

  /** True when at least one skill is enabled (a composition is expected). */
  readonly hasAgent = computed(() => this.enabledManifests().length > 0);

  /** True when the capacity gate blocked (context overflow, SPEC §8.3.5). */
  readonly capacityBlocked = computed(() => this._composed()?.capacity.blocked ?? false);

  // --- derivations the panel host / bus consume ----------------------------

  /** Layout descriptors for every enabled skill's panels (the dock dedupes). */
  readonly panels = computed<PanelDescriptor[]>(() => panelsFromManifests(this.enabledManifests()));

  /** Bus slot table from every enabled skill's `shared_state`. */
  readonly slots = computed<SlotDescriptor[]>(() => slotsFromManifests(this.enabledManifests()));

  /** Per-tool routing declarations (authoritative from the composed view when available). */
  readonly routingDecls = computed<Map<string, ToolRoutingDecl>>(() =>
    routingDeclsFrom(this._composed(), this.enabledManifests())
  );

  /** Monotonic guard so a slow/older compose response can't overwrite a newer one. */
  private composeSeq = 0;

  constructor() {
    // Re-compose whenever the enabled set, the primary hint, or the context
    // window changes. Reads only those three; writes only the result signals —
    // no self-referential loop.
    effect(() => {
      const manifests = this.enabledManifests();
      const hint = this.primaryHint();
      const nCtx = this.nCtx();
      void this.recompose(manifests, hint, nCtx);
    });
  }

  /** Force a re-compose with the current inputs (e.g. after changing `primaryHint`). */
  refresh(): void {
    void this.recompose(this.enabledManifests(), this.primaryHint(), this.nCtx());
  }

  private async recompose(
    manifests: readonly SkillManifest[],
    hint: string | null,
    nCtx: number
  ): Promise<void> {
    const seq = ++this.composeSeq;

    if (manifests.length === 0) {
      this._composed.set(null);
      this._error.set(null);
      this._composing.set(false);
      this.reportComposition(0); // nothing composed ⇒ arm the latch for the next transition
      return;
    }

    this._composing.set(true);
    try {
      const view = await this.ipc.invoke('compose_agent', {
        // Spread to a mutable copy; `SkillManifest[]` is assignable to `unknown[]`.
        manifests: [...manifests],
        primaryHint: hint ?? undefined,
        nCtx,
      });
      if (seq !== this.composeSeq) return; // superseded by a newer compose
      this._composed.set(view);
      this._error.set(null);
      // PRODUCT METRIC — composition rate (P1-25.1): only on a SUCCESSFUL
      // compose, so a failed/blocked compose isn't counted as an active agent.
      this.reportComposition(manifests.length);
    } catch (e) {
      if (seq !== this.composeSeq) return;
      this._composed.set(null);
      this._error.set(toComposeError(e));
    } finally {
      if (seq === this.composeSeq) this._composing.set(false);
    }
  }

  /**
   * Emit the P1-25.1 composition metric once per composition-active transition.
   * A composition is "active" when 2+ skills are composed OR a template drove
   * it; dropping back below that arms the latch so the next transition re-emits.
   * TelemetryService's own opt-in guard suppresses the actual emission when
   * telemetry is off.
   */
  private reportComposition(skillsActive: number): void {
    const viaTemplate = this.viaTemplate();
    const isComposition = skillsActive >= 2 || viaTemplate;
    if (!isComposition) {
      this.compositionReported = false;
      return;
    }
    if (this.compositionReported) return;
    this.compositionReported = true;
    this.telemetry.composition(skillsActive, viaTemplate);
  }
}

/**
 * Normalise anything thrown/rejected by the `compose_agent` invoke into a
 * {@link ComposeError}. The Rust command rejects with a `ComposeErrorView`
 * (`{ kind, message }`); a transport/parse failure is tagged `kind: 'ipc'`.
 */
export function toComposeError(e: unknown): ComposeError {
  if (e && typeof e === 'object') {
    const obj = e as { kind?: unknown; message?: unknown };
    if (typeof obj.kind === 'string' && typeof obj.message === 'string') {
      return { kind: obj.kind, message: obj.message };
    }
    if (typeof obj.message === 'string') {
      return { kind: 'ipc', message: obj.message };
    }
  }
  if (typeof e === 'string') return { kind: 'ipc', message: e };
  return { kind: 'ipc', message: 'composition failed (no detail from the core)' };
}
