import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  Directive,
  ElementRef,
  EventEmitter,
  Input,
  Output,
  TemplateRef,
  computed,
  contentChildren,
  signal,
  viewChildren,
} from '@angular/core';

/**
 * `tabs` widget (SPEC 9.4 · schema contracts/widgets/tabs.schema.json).
 *
 * A container that groups related child panels and exposes one at a time,
 * tracking an active-tab selection and emitting `tab_changed`. Content is
 * projected: a consumer marks each tab's content with the `appTabPanel`
 * directive (below) keyed to a tab id; the container renders the ACTIVE tab's
 * template. Panels are mounted lazily (only the active one is rendered).
 *
 * A11y (base contract §8, both themes, every state):
 *  - ARIA tablist / tab / tabpanel roles with aria-orientation, aria-selected,
 *    aria-controls / aria-labelledby wiring;
 *  - roving tabindex: one tab stop; Left/Right (horizontal) or Up/Down
 *    (vertical) move focus, Home/End jump to first/last, and activation follows
 *    `activation` (automatic = move-activates; manual = Enter/Space activates);
 *  - focus management: arrow navigation moves DOM focus to the target tab;
 *  - the selected tab is signalled by aria-selected + a non-hue indicator
 *    (underline bar + bold weight), never colour alone (WCAG 1.4.1);
 *  - mandatory loading / empty / error states (base contract §6).
 *
 * Styling is token-only (base contract §7).
 */

/** Marks a projected content template as one tab's panel: `<ng-template appTabPanel="details">`. */
@Directive({
  selector: 'ng-template[appTabPanel]',
  standalone: true,
})
export class TabPanelDirective {
  @Input('appTabPanel') tabId = '';
  constructor(public readonly template: TemplateRef<unknown>) {}
}

export interface TabDef {
  id: string;
  label: string;
  /** Optional decorative icon name (paired with the label, never a replacement). */
  icon?: string;
}

export type TabsOrientation = 'horizontal' | 'vertical';
export type TabsActivation = 'automatic' | 'manual';
export type TabsState = 'loading' | 'ready' | 'error';

let uidCounter = 0;

@Component({
  selector: 'app-tabs',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet],
  templateUrl: './tabs.component.html',
  styleUrl: './tabs.component.css',
})
export class TabsComponent {
  readonly uid = ++uidCounter;

  // --- signal-backed inputs ------------------------------------------------

  private readonly _tabs = signal<TabDef[]>([]);
  private readonly _state = signal<TabsState>('ready');
  private readonly _active = signal<string | null>(null);

  @Input()
  set tabs(value: TabDef[]) {
    this._tabs.set(value ?? []);
  }
  get tabs(): TabDef[] {
    return this._tabs();
  }

  @Input()
  set state(value: TabsState) {
    this._state.set(value ?? 'ready');
  }
  get state(): TabsState {
    return this._state();
  }

  /** Controlled active tab (schema binds_state mirror). */
  @Input()
  set activeTab(value: string | null | undefined) {
    if (value !== undefined && value !== null) this._active.set(value);
  }
  get activeTab(): string | null {
    return this.activeId();
  }

  /** Initial tab before any interaction or slot value (schema props.default_tab). */
  @Input()
  set defaultTab(value: string | undefined) {
    if (value && this._active() === null) this._active.set(value);
  }

  // --- plain config inputs -------------------------------------------------

  @Input() orientation: TabsOrientation = 'horizontal';
  @Input() activation: TabsActivation = 'automatic';
  @Input() density: 'comfortable' | 'compact' = 'comfortable';

  /** Visible panel heading (widget title). */
  @Input() heading?: string;
  /** Accessible name for the tablist (a11y.label / title fallback). */
  @Input() label?: string;

  /** Read-only resolution from the merge layer (base contract §5). */
  @Input() readonly = false;
  @Input() writer?: string;

  // Overridable state copy (base contract §6 — copy only).
  @Input() loadingLabel = 'Loading…';
  @Input() emptyLabel = 'Nothing here yet.';
  @Input() errorLabel = "Couldn't open this tab.";
  @Input() errorHint = 'Try again.';

  // --- outputs -------------------------------------------------------------

  /** `tab_changed`: the id of the newly-active tab. */
  @Output() tabChange = new EventEmitter<string>();
  /** Recovery affordance for the error state. */
  @Output() retry = new EventEmitter<void>();

  // --- queries -------------------------------------------------------------

  private readonly panels = contentChildren(TabPanelDirective);
  private readonly tabButtons = viewChildren<ElementRef<HTMLButtonElement>>('tabBtn');

  /** Focused tab index for roving tabindex; null until first focus (defaults to active). */
  private readonly _focused = signal<number | null>(null);

  // --- derived state -------------------------------------------------------

  readonly activeId = computed<string | null>(() => {
    const active = this._active();
    const tabs = this._tabs();
    if (active && tabs.some((t) => t.id === active)) return active;
    return tabs.length ? tabs[0].id : null;
  });

  private readonly activeIndex = computed<number>(() => {
    const id = this.activeId();
    const i = this._tabs().findIndex((t) => t.id === id);
    return i < 0 ? 0 : i;
  });

  readonly rovingIndex = computed<number>(() => this._focused() ?? this.activeIndex());

  readonly activePanel = computed<TemplateRef<unknown> | null>(() => {
    const id = this.activeId();
    if (!id) return null;
    const panel = this.panels().find((p) => p.tabId === id);
    return panel ? panel.template : null;
  });

  readonly phase = computed<'loading' | 'empty' | 'error' | 'ready'>(() => {
    const s = this._state();
    if (s === 'loading') return 'loading';
    if (s === 'error') return 'error';
    return this.activePanel() ? 'ready' : 'empty';
  });

  // --- ids -----------------------------------------------------------------

  tabControlId(id: string): string {
    return `tabs-${this.uid}-tab-${id}`;
  }

  panelId(id: string): string {
    return `tabs-${this.uid}-panel-${id}`;
  }

  // --- interaction ---------------------------------------------------------

  onClick(index: number): void {
    this._focused.set(index);
    const tab = this._tabs()[index];
    if (tab) this.activate(tab.id);
  }

  onFocus(index: number): void {
    this._focused.set(index);
  }

  onKeydown(event: KeyboardEvent, index: number): void {
    const tabs = this._tabs();
    const n = tabs.length;
    if (n === 0) return;
    const horizontal = this.orientation !== 'vertical';
    const prevKey = horizontal ? 'ArrowLeft' : 'ArrowUp';
    const nextKey = horizontal ? 'ArrowRight' : 'ArrowDown';

    let next = index;
    switch (event.key) {
      case nextKey:
        next = (index + 1) % n;
        break;
      case prevKey:
        next = (index - 1 + n) % n;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = n - 1;
        break;
      case 'Enter':
      case ' ':
      case 'Spacebar': {
        event.preventDefault();
        const cur = tabs[index];
        if (cur) this.activate(cur.id);
        return;
      }
      default:
        return;
    }

    event.preventDefault();
    this._focused.set(next);
    this.focusTab(next);
    if (this.activation === 'automatic') {
      const target = tabs[next];
      if (target) this.activate(target.id);
    }
  }

  private activate(id: string): void {
    if (this.readonly) return; // selection is owned by another skill (base contract §5)
    if (id === this.activeId()) return;
    this._active.set(id);
    this.tabChange.emit(id);
  }

  private focusTab(index: number): void {
    const btns = this.tabButtons();
    const el = btns[index];
    if (el) el.nativeElement.focus();
  }
}
