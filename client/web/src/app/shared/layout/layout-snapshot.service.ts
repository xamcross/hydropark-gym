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
 * up.
 *
 * ── scoping the buffer to the load that produced it (fix, post-review) ──────
 * A naive "buffer forever until the next register()" is WRONG: if a load's own
 * combo never ends up producing a live agent (e.g. every named skill is
 * `unresolved` — see `TemplatesService`), no dock will EVER mount as a
 * consequence of THAT load, yet the buffered overrides would sit indefinitely
 * and could be misapplied to a LATER, causally-unrelated dock mount (e.g. the
 * user manually toggling a skill on for an unrelated reason). `restore()`
 * returns an opaque token identifying that specific buffered request;
 * {@link invalidate} drops it — but ONLY if it is still the current pending
 * one (a stale/lost-race invalidate against an already-superseded or
 * already-applied token is a safe no-op, so two overlapping restores can never
 * cross-cancel each other). The caller that knows a restore is no longer
 * wanted (`TemplatesService`, once it knows synchronously that its own load
 * enabled nothing) calls `invalidate(token)` right away — no reliance on
 * guessing Angular's change-detection/effect timing.
 *
 * {@link clear} ALSO drops any buffered restore unconditionally — a second,
 * coarser safety net: if a dock legitimately mounted, registered, then
 * unmounted again (the composed agent went idle) BEFORE a still-pending
 * restore was consumed, that restore must not survive to be replayed by
 * whatever unrelated dock mounts next.
 */
@Injectable({ providedIn: 'root' })
export class LayoutSnapshotService {
  private bridge: LayoutSnapshotBridge | null = null;
  private pendingRestore: { token: number; overrides: PanelOverride[] } | null = null;
  private nextToken = 0;

  /** Called by the live dock owner once its `LayoutService` instance exists. */
  register(bridge: LayoutSnapshotBridge): void {
    this.bridge = bridge;
    if (this.pendingRestore) {
      const { overrides } = this.pendingRestore;
      this.pendingRestore = null;
      bridge.restore(overrides);
    }
  }

  /**
   * Called by the live dock owner when its dock is torn down (component
   * destroy, or the agent going idle). Also drops any still-buffered restore
   * — see the class doc's "scoping the buffer" note.
   */
  clear(): void {
    this.bridge = null;
    this.pendingRestore = null;
  }

  /** The current panel-override snapshot, or `[]` when no dock is live (nothing to snapshot). */
  snapshot(): PanelOverride[] {
    return this.bridge ? this.bridge.capture() : [];
  }

  /**
   * Reapply a template's saved overrides. Applies immediately if a dock is
   * live; otherwise buffers until the next {@link register} (see the class
   * doc's mount-order note). Silently ignores a malformed/non-array payload
   * rather than throwing — a corrupt `ui_overrides` must never block a
   * template load — returning `null` in that case (nothing to invalidate).
   *
   * Returns a token the caller MAY pass to {@link invalidate} if it later
   * determines (synchronously, before yielding back to its own caller) that
   * this specific restore is no longer wanted. Ignoring the token is always
   * safe — an un-invalidated buffered restore behaves exactly as before.
   */
  restore(overrides: unknown): number | null {
    if (!Array.isArray(overrides)) return null;
    const list = overrides as PanelOverride[];
    const token = ++this.nextToken;
    if (this.bridge) {
      this.bridge.restore(list);
      return token; // already applied — nothing left pending for this token
    }
    this.pendingRestore = { token, overrides: list };
    return token;
  }

  /**
   * Drop a buffered restore, but ONLY if `token` is still the current pending
   * one. A token whose restore already applied (bridge was live), or that has
   * since been superseded by a newer `restore()` call, is simply a no-op —
   * this can never cancel a DIFFERENT, still-relevant buffered restore.
   */
  invalidate(token: number): void {
    if (this.pendingRestore?.token === token) this.pendingRestore = null;
  }
}
