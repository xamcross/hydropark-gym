import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import {
  ArrangedPanel,
  CAPABILITY_DEFAULTS,
  LayoutArrangement,
  PanelDescriptor,
  PanelOverride,
  PanelRegion,
  PanelUiState,
  SIDE_FOLD_BREAKPOINT_PX,
  arrange,
  clampSize,
  defaultUiState,
  fromOverrides,
  moveInList,
  panelKey,
  toOverrides,
} from './layout.model';

/**
 * LayoutService (P1-06.5 · SPEC §9.5) — the stateful shell of the layout
 * engine. It owns two signals — the panel DESCRIPTORS (fed from the merge
 * layer) and the per-panel UI STATE (collapsed / pinned / order / size) — and
 * derives the visible {@link arrangement} by delegating ALL placement, dedupe,
 * ordering and responsive-fold decisions to the pure functions in
 * `layout.model.ts`. Every mutation replaces the UI-state map immutably so
 * `computed`/OnPush consumers re-render correctly.
 *
 * Scope: provided by {@link LayoutDockComponent} (component-level provider), so
 * each dock instance carries its own layout state and there is no global
 * singleton to collide with other in-flight work. Not `providedIn:'root'`.
 *
 * Responsive input: the viewport width drives {@link narrow}; a `resize`
 * listener keeps it live (cleaned up via `DestroyRef`). Tests can bypass the
 * DOM entirely with {@link setViewportWidth}.
 */
@Injectable()
export class LayoutService {
  private readonly _panels = signal<readonly PanelDescriptor[]>([]);
  private readonly _ui = signal<ReadonlyMap<string, PanelUiState>>(new Map());

  /** Current viewport width in px; defaults wide so no-DOM/SSR is never "narrow". */
  readonly viewportWidth = signal<number>(SIDE_FOLD_BREAKPOINT_PX * 2);
  /** The width below which `side` folds into the bottom drawer. */
  readonly breakpointPx = signal<number>(SIDE_FOLD_BREAKPOINT_PX);

  /** True when the responsive fold is active. */
  readonly narrow = computed<boolean>(() => this.viewportWidth() < this.breakpointPx());

  /** The full, render-ready arrangement (pure derivation — see `arrange`). */
  readonly arrangement = computed<LayoutArrangement>(() => arrange(this._panels(), this._ui(), this.narrow()));

  constructor() {
    const destroyRef = inject(DestroyRef);
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      if (typeof window.innerWidth === 'number' && window.innerWidth > 0) {
        this.viewportWidth.set(window.innerWidth);
      }
      const onResize = (): void => this.viewportWidth.set(window.innerWidth);
      window.addEventListener('resize', onResize, { passive: true });
      destroyRef.onDestroy(() => window.removeEventListener('resize', onResize));
    }
  }

  // --- inputs --------------------------------------------------------------

  /** Replace the panel descriptors (from the merge layer). UI-state overrides are preserved by key. */
  setPanels(panels: readonly PanelDescriptor[]): void {
    this._panels.set(panels ?? []);
  }

  /** Override the viewport width (used by tests, or a host that measures itself). */
  setViewportWidth(px: number): void {
    this.viewportWidth.set(px);
  }

  /** Override the fold breakpoint. */
  setBreakpoint(px: number): void {
    this.breakpointPx.set(px);
  }

  // --- reads ---------------------------------------------------------------

  /** The live UI state for a panel (defaulted if untouched). */
  uiState(key: string): PanelUiState {
    return this._ui().get(key) ?? defaultUiState(key);
  }

  canCollapse(key: string): boolean {
    const d = this.descriptor(key);
    return !!d && (d.collapsible ?? CAPABILITY_DEFAULTS.collapsible);
  }

  canPin(key: string): boolean {
    const d = this.descriptor(key);
    return !!d && (d.pinnable ?? CAPABILITY_DEFAULTS.pinnable);
  }

  canResize(key: string): boolean {
    const d = this.descriptor(key);
    return !!d && (d.resizable ?? CAPABILITY_DEFAULTS.resizable);
  }

  // --- actions: collapse ---------------------------------------------------

  collapse(key: string): void {
    if (this.canCollapse(key)) this.patch(key, { collapsed: true });
  }

  expand(key: string): void {
    // Expand is always allowed (a non-collapsible panel is simply never collapsed).
    this.patch(key, { collapsed: false });
  }

  toggleCollapse(key: string): void {
    if (!this.canCollapse(key)) return;
    this.patch(key, { collapsed: !this.uiState(key).collapsed });
  }

  // --- actions: pin --------------------------------------------------------

  pin(key: string): void {
    if (this.canPin(key)) this.patch(key, { pinned: true });
  }

  unpin(key: string): void {
    this.patch(key, { pinned: false });
  }

  togglePin(key: string): void {
    if (!this.canPin(key)) return;
    this.patch(key, { pinned: !this.uiState(key).pinned });
  }

  // --- actions: resize -----------------------------------------------------

  resize(key: string, px: number): void {
    if (this.canResize(key)) this.patch(key, { size: clampSize(px) });
  }

  clearSize(key: string): void {
    this.patch(key, { size: null });
  }

  // --- actions: reorder ----------------------------------------------------

  /**
   * Move `key` to `toIndex` within its LOGICAL region (`descriptor.region`, so
   * the move persists whether the panel is currently shown in the side column
   * or the narrow drawer). The whole region is renumbered densely (0..n-1) so
   * the manual order stays deterministic and stable across future arranges.
   */
  reorder(key: string, toIndex: number): void {
    const d = this.descriptor(key);
    if (!d) return;
    const keys = this.orderedKeysForRegion(d.region);
    const from = keys.indexOf(key);
    if (from < 0) return;
    const moved = moveInList(keys, from, toIndex);
    const map = new Map(this._ui());
    moved.forEach((k, i) => {
      const prev = map.get(k) ?? defaultUiState(k);
      map.set(k, { ...prev, order: i });
    });
    this._ui.set(map);
  }

  moveUp(key: string): void {
    const i = this.indexInRegion(key);
    if (i > 0) this.reorder(key, i - 1);
  }

  moveDown(key: string): void {
    const d = this.descriptor(key);
    if (!d) return;
    const keys = this.orderedKeysForRegion(d.region);
    const i = keys.indexOf(key);
    if (i >= 0 && i < keys.length - 1) this.reorder(key, i + 1);
  }

  // --- actions: reset / persistence ---------------------------------------

  /** Drop all UI-state changes for one panel (back to engine defaults). */
  reset(key: string): void {
    const map = new Map(this._ui());
    if (map.delete(key)) this._ui.set(map);
  }

  /** Drop every user override across all panels. */
  resetAll(): void {
    this._ui.set(new Map());
  }

  /** Snapshot the non-default UI state for persistence into a template (SPEC §9.5 → §10). */
  serializeOverrides(): PanelOverride[] {
    return toOverrides(this._ui());
  }

  /** Restore UI state from persisted template overrides. */
  applyOverrides(overrides: readonly PanelOverride[]): void {
    this._ui.set(fromOverrides(overrides));
  }

  // --- internals -----------------------------------------------------------

  private descriptor(key: string): PanelDescriptor | undefined {
    return this._panels().find((p) => panelKey(p) === key);
  }

  /** The current visible key order for a logical region (the drawer stands in for `side` when narrow). */
  private orderedKeysForRegion(region: PanelRegion): string[] {
    const a = this.arrangement();
    const list: ArrangedPanel[] = region === 'side' ? (a.isNarrow ? a.drawer : a.side) : region === 'bottom' ? a.bottom : a.inline;
    return list.map((p) => p.key);
  }

  private indexInRegion(key: string): number {
    const d = this.descriptor(key);
    if (!d) return -1;
    return this.orderedKeysForRegion(d.region).indexOf(key);
  }

  private patch(key: string, partial: Partial<PanelUiState>): void {
    const map = new Map(this._ui());
    const prev = map.get(key) ?? defaultUiState(key);
    map.set(key, { ...prev, ...partial, key });
    this._ui.set(map);
  }
}
