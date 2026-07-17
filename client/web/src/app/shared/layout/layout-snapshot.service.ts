import { Injectable } from '@angular/core';
import { PanelOverride } from './layout.model';

/**
 * The capture/restore pair a live layout owner exposes to
 * {@link LayoutSnapshotService}. Today the only owner is
 * `ComposedPanelHostComponent`, reaching into its child `LayoutDockComponent`'s
 * public `layout: LayoutService`.
 */
export interface LayoutSnapshotBridge {
  capture(): PanelOverride[];
  restore(overrides: readonly PanelOverride[]): void;
}

/**
 * HYDROPARK — LAYOUT SNAPSHOT SEAM (Task 11b, SPEC §9.5 → §10)
 * -----------------------------------------------------------------------------
 * `LayoutService` (the panel-arrangement engine's stateful shell) is provided
 * PER `LayoutDockComponent` (`providers: [LayoutService]` on that component),
 * NOT `providedIn: 'root'` — see layout.service.ts's own doc comment: each dock
 * instance carries its own layout state so there is no global singleton. That
 * means a root-scoped service like `TemplatesService` cannot simply
 * `inject(LayoutService)` to snapshot/restore the live panel arrangement for a
 * template — there is no single instance to inject.
 *
 * This service is the bridge. Whichever component actually HOSTS the live dock
 * (today `ComposedPanelHostComponent`, via a `viewChild(LayoutDockComponent)`
 * reading that child's public `layout` property) {@link register}s a thin
 * capture/restore pair here once its dock exists, and {@link clear}s it on
 * destroy. `TemplatesService` then calls {@link snapshot} / {@link restore}
 * without ever knowing which component, or how many nested layers, actually
 * own the `LayoutService` instance.
 *
 * ── the mount-order race, and why `restore` buffers ──────────────────────────
 * `ComposedPanelHostComponent` (and therefore its dock) only exists while the
 * shell's `view() === 'assistant'` (see app.component.html) — it is not
 * mounted while the user is on the Templates gallery. Loading a template from
 * the gallery enables skills FIRST (which is what makes the dock have
 * anything to arrange) and only THEN switches the shell back to 'assistant';
 * the dock will not exist yet at the exact moment `TemplatesService.load()`
 * calls {@link restore}. Rather than papering over that with an arbitrary
 * `setTimeout`, `restore()` stashes the overrides as `pendingRestore` when no
 * bridge is registered, and {@link register} replays them the moment a dock
 * (any dock — a fresh mount after a template-driven skill-enable counts) shows
 * up. No dock ever mounting (nothing to arrange) simply leaves the pending
 * value unconsumed — inert, not a leak of consequence.
 */
@Injectable({ providedIn: 'root' })
export class LayoutSnapshotService {
  private bridge: LayoutSnapshotBridge | null = null;
  private pendingRestore: PanelOverride[] | null = null;

  /** Called by the live dock owner once its `LayoutService` instance exists. */
  register(bridge: LayoutSnapshotBridge): void {
    this.bridge = bridge;
    if (this.pendingRestore) {
      const overrides = this.pendingRestore;
      this.pendingRestore = null;
      bridge.restore(overrides);
    }
  }

  /** Called by the live dock owner when its dock is torn down (component destroy, or the agent going idle). */
  clear(): void {
    this.bridge = null;
  }

  /** The current panel-override snapshot, or `[]` when no dock is live (nothing to snapshot). */
  snapshot(): PanelOverride[] {
    return this.bridge ? this.bridge.capture() : [];
  }

  /**
   * Reapply a template's saved overrides. Applies immediately if a dock is
   * live; otherwise buffers until the next {@link register} (see the mount-
   * order note above). Silently ignores a malformed/non-array payload rather
   * than throwing — a corrupt `ui_overrides` must never block a template load.
   */
  restore(overrides: unknown): void {
    if (!Array.isArray(overrides)) return;
    const list = overrides as PanelOverride[];
    if (this.bridge) {
      this.bridge.restore(list);
    } else {
      this.pendingRestore = list;
    }
  }
}
