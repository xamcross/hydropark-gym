/* =============================================================================
   HYDROPARK — TEMPLATES SERVICE  (Task 11b, SPEC §10 — the "Weeknight Chef" beat)
   -----------------------------------------------------------------------------
   Thin wrapper over the three Task 11a IPC commands (`template_save` /
   `template_list` / `template_load`) plus the client-side glue those commands
   need to actually DO something: turning the currently-enabled skill set +
   live layout into a saveable template, and turning a loaded template back
   into an enabled skill set + restored layout.

   ── the enablement limit (read this before touching `applyCombo`) ───────────
   `CompositionService.enabledManifests()` — the live "what's on" signal the
   rest of the composed-agent flow reads — is DERIVED today from exactly two
   sources: `SessionService.kitchenSkillEnabled()` (the free skill) and
   `CookingAssistantService.enabled()` (the one paid skill). Arbitrary
   marketplace skills don't yet compose (tracked as punch item F03/F07) — see
   that service's own doc comment. This file does NOT redesign that; it only
   drives the two enablement seams that already exist. A template naming any
   OTHER skill id resolves fine on the Rust/IPC side (`skill_ids` names it) but
   this client can't flip it on automatically yet — `load()` reports those ids
   back as `unresolved` (distinct from `missingSkills`, which is an IPC-level
   "not installed / wrong version" failure) so the gallery can say so plainly.
   ============================================================================= */

import { Injectable, computed, inject, signal } from '@angular/core';
import { IPC_PORT } from '../ipc/ipc.port';
import { TemplateSaveArgs, TemplateView } from '../ipc/contract';
import { CompositionService } from '../composition/composition.service';
import { LayoutSnapshotService } from '../shared/layout/layout-snapshot.service';
import { NotificationService } from '../shared/notify/notification.service';
import { SessionService } from '../state/session.service';
import { CookingAssistantService } from '../skills/cooking-assistant/cooking-assistant.service';

/** The one bundled Phase-0 model — see SPEC §16.1; there is no model picker yet. */
export const TEMPLATE_BASE_MODEL = 'qwen2.5-3b-instruct-q4_k_m';

/** The skill ids `applyCombo` actually knows how to flip on/off (see file header). */
const AUTO_ENABLE_SKILLS = new Set<string>(['kitchen-timer', 'cooking-assistant']);

/** The result of a `load()` call — a discriminated-ish shape the gallery renders directly. */
export type TemplateLoadOutcome =
  | {
      ok: true;
      /**
       * Skill ids the template named that this client's enablement seam
       * couldn't turn on for you (unknown to `CompositionService`, or a known
       * paid skill still locked). Empty when everything resolved cleanly.
       */
      unresolved: string[];
    }
  | {
      ok: false;
      /** From the IPC result verbatim — not installed, or installed at an incompatible version. */
      missingSkills: string[];
    };

@Injectable({ providedIn: 'root' })
export class TemplatesService {
  private readonly ipc = inject(IPC_PORT);
  private readonly composition = inject(CompositionService);
  private readonly layoutSnapshot = inject(LayoutSnapshotService);
  private readonly notify = inject(NotificationService);
  private readonly session = inject(SessionService);
  private readonly cooking = inject(CookingAssistantService);

  private readonly _templates = signal<readonly TemplateView[]>([]);
  /** "My Templates" — newest-saved first (mirrors the Rust store's `updated_at DESC`). */
  readonly templates = this._templates.asReadonly();

  private readonly _loading = signal(false);
  readonly loading = this._loading.asReadonly();

  readonly isEmpty = computed(() => !this._loading() && this._templates().length === 0);

  /** Re-pull the gallery from the store. */
  async refresh(): Promise<void> {
    this._loading.set(true);
    try {
      const list = await this.ipc.invoke('template_list', undefined);
      this._templates.set(list);
    } finally {
      this._loading.set(false);
    }
  }

  /**
   * Save the CURRENT composed combo (whatever `CompositionService` reports
   * enabled right now) + the live layout as a new named template. Refreshes
   * the gallery and toasts on success.
   */
  async save(name: string): Promise<TemplateView> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Template name is required.');

    const skillRefs: Array<[string, string]> = this.composition
      .enabledManifests()
      .map((m) => [m.id, m.version ?? '1.0.0'] as [string, string]);

    const args: TemplateSaveArgs = {
      name: trimmed,
      skill_refs: skillRefs,
      base_model: TEMPLATE_BASE_MODEL,
      ui_overrides: this.layoutSnapshot.snapshot(),
    };

    const view = await this.ipc.invoke('template_save', args);
    await this.refresh();
    this.notify.toast({
      title: 'Template saved',
      body: `"${view.name}" is ready in My Templates.`,
      severity: 'success',
    });
    return view;
  }

  /**
   * Load a template: resolve it over IPC, then either report the missing/
   * incompatible skills (SPEC §10 — "explain and offer reinstall") or enable
   * the resolvable combo, restore the layout, and mark the composition as
   * template-driven (`CompositionService.viaTemplate`, read by the P1-25.1
   * composition metric).
   */
  async load(id: string): Promise<TemplateLoadOutcome> {
    const res = await this.ipc.invoke('template_load', { id });
    if (!res.ok) {
      return { ok: false, missingSkills: res.missing_skills };
    }

    const unresolved = await this.applyCombo(res.skill_ids);
    this.layoutSnapshot.restore(res.ui_overrides);
    this.composition.viaTemplate.set(true);
    return { ok: true, unresolved };
  }

  // --- internals -------------------------------------------------------------

  /**
   * Drive the two enablement seams that exist today so the live combo matches
   * `skillIds` EXACTLY (enables what's named, disables what isn't) — this is
   * what makes "disable everything → load → the saved combo comes back"
   * (the B2 demo beat) true. Returns the ids it could not resolve (see the
   * file header) rather than throwing — a template partially outside this
   * client's current enablement reach still loads what it can.
   */
  private async applyCombo(skillIds: readonly string[]): Promise<string[]> {
    const wanted = new Set(skillIds);
    const unresolved: string[] = [];

    // kitchen-timer: free, a synchronous flag either way.
    this.session.kitchenSkillEnabled.set(wanted.has('kitchen-timer'));

    // cooking-assistant: paid, gated behind UnlockService. `enable()` itself
    // refuses (returns false, makes no IPC call) while locked — that is
    // reported as "unresolved", not silently ignored.
    if (wanted.has('cooking-assistant')) {
      const enabled = await this.cooking.enable();
      if (!enabled) unresolved.push('cooking-assistant');
    } else if (this.cooking.enabled()) {
      await this.cooking.disable();
    }

    for (const id of skillIds) {
      if (!AUTO_ENABLE_SKILLS.has(id)) unresolved.push(id);
    }

    return unresolved;
  }
}
