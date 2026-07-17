/* =============================================================================
   HYDROPARK — ENABLED-SKILLS STORE  (Task 14 · F03/F07: composition enablement seam)
   -----------------------------------------------------------------------------
   A generic, client-side "which skills beyond the two P0 ones are enabled"
   store. `CompositionService`'s `enabledManifests` was hardcoded to exactly two
   signals (`SessionService.kitchenSkillEnabled` + `CookingAssistantService.
   enabled`), so no other marketplace skill could ever compose — Nutrition
   Coach, Packing List, Travel Planner (and any future skill) had no seam to
   flip on (UX-PUNCH-LIST.md F07).

   This is a TARGETED addition, not a redesign: a minimal id-set signal with
   enable/disable/toggle + per-id read signals. `CompositionService` unions
   `enabledIds()` (resolved through `manifestFor`) into its existing P0-derived
   manifest list; `PurchaseService` routes non-P0 enable/disable intents here
   instead of the Rust `skill_enable` command, whose arg is the fixed 2-value P0
   `SkillId` enum and cannot deserialize an arbitrary marketplace id (F03).

   `providedIn: 'root'` — like `CompositionService`, this is app-global: there
   is one enabled-skill set for the one active composed agent.
   ============================================================================= */

import { Injectable, Signal, computed, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class EnabledSkillsService {
  private readonly _enabled = signal<ReadonlySet<string>>(new Set());

  /** The enabled skill ids, as an array (stable membership, not stable order beyond insertion). */
  readonly enabledIds: Signal<string[]> = computed(() => [...this._enabled()]);

  /** Enable a skill id. No-op if already enabled (keeps the signal reference stable). */
  enable(id: string): void {
    this._enabled.update((current) => (current.has(id) ? current : new Set(current).add(id)));
  }

  /** Disable a skill id. No-op if not enabled. */
  disable(id: string): void {
    this._enabled.update((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }

  /** Flip a skill id's enabled state. */
  toggle(id: string): void {
    if (this.has(id)) this.disable(id);
    else this.enable(id);
  }

  /** Synchronous membership check (untracked read — same shape as a plain getter). */
  has(id: string): boolean {
    return this._enabled().has(id);
  }

  /** A reactive per-id membership signal, for a template binding (e.g. a toggle switch). */
  isEnabled(id: string): Signal<boolean> {
    return computed(() => this._enabled().has(id));
  }
}
