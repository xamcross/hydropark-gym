import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  Directive,
  Input,
  TemplateRef,
  computed,
  contentChildren,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import {
  ArrangedPanel,
  DEFAULT_PANEL_SIZE_PX,
  MAX_PANEL_SIZE_PX,
  MIN_PANEL_SIZE_PX,
  PanelDescriptor,
  RESIZE_STEP_PX,
} from './layout.model';
import { LayoutService } from './layout.service';

/**
 * Context handed to a projected panel-body template:
 *   `<ng-template appPanelBody let-panel>{{ panel.descriptor.widgetType }}</ng-template>`
 * `$implicit` and the named `panel` both point at the {@link ArrangedPanel}, so
 * consumers can `let-panel` or `let-panel="panel"`.
 */
export interface PanelBodyContext {
  $implicit: ArrangedPanel;
  panel: ArrangedPanel;
}

/**
 * Marks an `<ng-template>` as the body renderer for the dock (P1-06.5). This is
 * the content-projection SEAM: the dock owns the panel CHROME (header,
 * collapse/pin/reorder/resize affordances, landmarks, states) and hands each
 * panel's inner content out to the consumer — the dock never hard-depends on
 * any concrete widget component (SPEC §9.5 / contract §1).
 *
 * Match precedence (most specific wins):
 *   `appPanelBody="<panelKey>"`     → that exact panel;
 *   `appPanelBody="<widgetType>"`   → any panel of that type;
 *   `appPanelBody` (empty)          → the default/fallback body for all panels.
 */
@Directive({
  selector: 'ng-template[appPanelBody]',
  standalone: true,
})
export class PanelBodyDirective {
  /** '' (default), a `widgetType`, or a full `panelKey`. */
  @Input('appPanelBody') match = '';
  constructor(readonly template: TemplateRef<PanelBodyContext>) {}
}

let dockUid = 0;

/**
 * LayoutDockComponent (P1-06.5 · SPEC §9.5) — renders the arranged panels into
 * their region slots. It delegates every placement decision to
 * {@link LayoutService} (which it provides at component scope) and draws:
 *   - a `side` complementary landmark (a vertical panel stack);
 *   - a keyboard-reachable bottom DRAWER holding the narrow-folded side panels;
 *   - a `bottom` region and `inline` cards;
 *   - per-panel chrome: collapse disclosure, pin toggle, reorder up/down, and an
 *     ARIA `separator` resize handle — all keyboard operable;
 *   - loading / empty states (contract §6).
 *
 * Styling is token-only (contract §7); a11y follows the base contract §8. The
 * actual widget for each panel is projected via {@link PanelBodyDirective}, so
 * this component builds without importing any widget.
 */
@Component({
  selector: 'app-layout-dock',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet],
  templateUrl: './layout-dock.component.html',
  styleUrl: './layout-dock.component.css',
  providers: [LayoutService],
})
export class LayoutDockComponent {
  readonly uid = ++dockUid;

  /** The layout engine, scoped to this dock. Public so the template can invoke actions. */
  readonly layout = inject(LayoutService);

  // --- inputs --------------------------------------------------------------

  /** Panel descriptors from the merge layer. */
  readonly panels = input<readonly PanelDescriptor[]>([]);
  /** Show the loading affordance in place of panel bodies (contract §6). */
  readonly loading = input(false);
  /** Optional explicit fold breakpoint (px); `null` keeps the engine default. */
  readonly narrowBreakpoint = input<number | null>(null);

  // Accessible names + overridable state copy (contract §6 — copy only).
  readonly sideLabel = input('Skill panels');
  readonly bottomLabel = input('Bottom panels');
  readonly drawerLabel = input('Panels');
  readonly inlineLabel = input('Inline panels');
  readonly emptyLabel = input('No panels yet — enable a skill to add tools here.');
  readonly loadingLabel = input('Loading…');
  readonly noRendererLabel = input('No renderer available for this panel.');

  // --- derived -------------------------------------------------------------

  readonly arrangement = this.layout.arrangement;
  readonly narrow = this.layout.narrow;

  /** Whole-drawer disclosure (the narrow-folded side panels). */
  readonly drawerOpen = signal(false);

  readonly isEmpty = computed<boolean>(() => {
    if (this.loading()) return false;
    const a = this.arrangement();
    return a.side.length + a.bottom.length + a.inline.length + a.drawer.length === 0;
  });

  // Constants surfaced to the template.
  readonly minSize = MIN_PANEL_SIZE_PX;
  readonly maxSize = MAX_PANEL_SIZE_PX;
  readonly defaultSize = DEFAULT_PANEL_SIZE_PX;

  private readonly bodies = contentChildren(PanelBodyDirective, { descendants: true });

  constructor() {
    effect(() => this.layout.setPanels(this.panels()));
    effect(() => {
      const bp = this.narrowBreakpoint();
      if (bp !== null) this.layout.setBreakpoint(bp);
    });
  }

  // --- body projection -----------------------------------------------------

  /** Resolve the most specific projected body template for a panel (key → type → default). */
  bodyTemplate(panel: ArrangedPanel): TemplateRef<PanelBodyContext> | null {
    const dirs = this.bodies();
    const byKey = dirs.find((d) => d.match === panel.key);
    if (byKey) return byKey.template;
    const byType = dirs.find((d) => d.match === panel.descriptor.widgetType);
    if (byType) return byType.template;
    const fallback = dirs.find((d) => d.match === '');
    return fallback ? fallback.template : null;
  }

  bodyContext(panel: ArrangedPanel): PanelBodyContext {
    return { $implicit: panel, panel };
  }

  // --- naming / ids --------------------------------------------------------

  panelName(panel: ArrangedPanel): string {
    return panel.descriptor.title ?? panel.descriptor.widgetType;
  }

  headingId(panel: ArrangedPanel): string {
    return `ld-${this.uid}-${this.slug(panel.key)}-title`;
  }

  bodyId(panel: ArrangedPanel): string {
    return `ld-${this.uid}-${this.slug(panel.key)}-body`;
  }

  /** CSS custom-property value for a panel's resolved size, or null for natural size. */
  panelSizeVar(panel: ArrangedPanel): string | null {
    return panel.ui.size !== null ? `${panel.ui.size}px` : null;
  }

  private slug(key: string): string {
    return key.replace(/[^a-z0-9]+/gi, '-');
  }

  // --- keyboard: resize separator -----------------------------------------

  /** Arrow keys nudge the size by one step; Home/End jump to min/max (ARIA separator pattern). */
  onResizeKey(event: KeyboardEvent, panel: ArrangedPanel): void {
    const current = panel.ui.size ?? DEFAULT_PANEL_SIZE_PX;
    let next = current;
    switch (event.key) {
      case 'ArrowUp':
      case 'ArrowRight':
        next = current + RESIZE_STEP_PX;
        break;
      case 'ArrowDown':
      case 'ArrowLeft':
        next = current - RESIZE_STEP_PX;
        break;
      case 'Home':
        next = MIN_PANEL_SIZE_PX;
        break;
      case 'End':
        next = MAX_PANEL_SIZE_PX;
        break;
      default:
        return;
    }
    event.preventDefault();
    this.layout.resize(panel.key, next);
  }
}
