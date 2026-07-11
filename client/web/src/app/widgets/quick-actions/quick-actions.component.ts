import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

/* =============================================================================
   quick_actions widget (P1-06.4 · SPEC 9.4 / 9.3 #2 / 8.4)
   -----------------------------------------------------------------------------
   A stateless ACTION LAUNCHER: 1–12 labelled buttons, each of which either
   invokes a FIXED tool DETERMINISTICALLY (the UI-first path — no model round
   trip, the reliability backstop for a 3B model) or inserts a fixed prompt into
   the composer. It binds NO primary slot and writes NO slot directly; writes
   reach shared state only through the per-action tool's own `writes_state`.

   Presentational only: the component receives the authored `actions` (props)
   plus the RESOLVED per-action runtime projection (enabled/pending/readonly/
   writer — produced by the core + merge layer over IPC) and emits an `invoke`
   intent that the HOST routes to the tool / composer. It never touches the bus
   itself. Contract §§2,3,4,5,6,7,8 obeyed; see quick_actions.schema.json.
   ============================================================================= */

/** Closed, token-mapped style-variant vocabulary (base contract §7). */
export type StyleTone = 'default' | 'neutral' | 'accent' | 'positive' | 'caution' | 'danger';
export type StyleEmphasis = 'subtle' | 'normal' | 'strong';
export type StyleDensity = 'comfortable' | 'compact';
export type StyleAlign = 'start' | 'center' | 'end';

export type QuickActionsPhase = 'loading' | 'ready' | 'empty' | 'error';
export type QuickActionsLayout = 'row' | 'column' | 'grid';
export type QuickActionKind = 'tool' | 'prompt';

/** props.actions[] — authored, immutable-per-instance config (canonical superset). */
export interface QuickAction {
  /** Optional stable snake_case id (payload key + updates_widget target). */
  id?: string;
  /** Visible text AND accessible name — ALWAYS present, so meaning is never colour/icon-only (WCAG 1.4.1). */
  label: string;
  /** TOOL action: deterministic invocation of this tool. Mutually exclusive with `prompt`. */
  tool?: string;
  /** PROMPT action: text inserted into the composer (does NOT auto-send). Mutually exclusive with `tool`. */
  prompt?: string;
  /** Decorative leading design-system icon token; the label carries the meaning (icon is aria-hidden). */
  icon?: string;
  /** Per-action semantic colour role — never the sole signal, always paired with the label. */
  tone?: StyleTone;
  /** Per-action visual weight (`strong` marks the primary button). */
  emphasis?: StyleEmphasis;
  /** When true, activation opens a confirmation step before invoking (destructive actions). */
  confirm?: boolean;
}

/** runtimeState.actions[] — RESOLVED per-action flags (merge + execution); never authored. */
export interface QuickActionRuntime {
  id?: string;
  /** False when gated off by a reads_state condition or the read-only rule. Stays FOCUSABLE (aria-disabled). */
  enabled?: boolean;
  /** True while this action's tool is in flight (busy affordance, aria-busy, non-activatable). */
  pending?: boolean;
  /** True when the tool performs a non-commutative write on a slot owned by a DIFFERENT skill (contract §5). */
  readonly?: boolean;
  /** Writer-of-record skill for the "Managed by {writer}" description when `readonly`. */
  writer?: string;
}

/** Surfaced structured tool-execution error (error phase; never swallowed — §6 / SPEC 8.4). */
export interface QuickActionsError {
  message: string;
  action_id?: string;
}

/** Intent the host routes to the tool / composer (bus direction 2). */
export interface QuickActionInvocation {
  index: number;
  id?: string;
  kind: QuickActionKind;
  label: string;
  tool?: string;
  prompt?: string;
}

/** Overridable lifecycle copy (§6 — copy only, never behaviour). */
export interface QuickActionsCopy {
  loading: string;
  empty: string;
  errorFallback: string;
}

/** Internal merged view-model of one button (authored props ∪ resolved runtime). */
interface ActionVM extends QuickAction {
  index: number;
  kind: QuickActionKind;
  enabled: boolean;
  pending: boolean;
  readonly: boolean;
  writer?: string;
}

@Component({
  selector: 'app-quick-actions',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './quick-actions.component.html',
  styleUrl: './quick-actions.component.css',
})
export class QuickActionsComponent {
  // --- props (authored) ---
  readonly actions = input.required<QuickAction[]>();
  readonly layout = input<QuickActionsLayout>('row');
  readonly columns = input<number | null>(null);
  // --- cluster-level style variants (base contract §7) ---
  readonly density = input<StyleDensity>('comfortable');
  readonly align = input<StyleAlign>('start');
  // --- resolved runtime projection ---
  readonly phase = input<QuickActionsPhase>('ready');
  readonly runtime = input<QuickActionRuntime[] | null>(null);
  readonly error = input<QuickActionsError | null>(null);
  // --- a11y + copy ---
  readonly label = input<string>('Quick actions');
  readonly states = input<Partial<QuickActionsCopy>>({});

  // --- outputs ---
  /** User activated a usable action — the host routes it to the tool / composer. */
  readonly invoke = output<QuickActionInvocation>();
  /** User dismissed the error banner (recovery affordance, §6). */
  readonly dismiss = output<void>();

  // --- local UI state ---
  private readonly confirming = signal<number | null>(null);
  private readonly confirmBtn = viewChild<ElementRef<HTMLButtonElement>>('confirmBtn');
  private returnFocusEl: HTMLElement | null = null;

  private readonly defaultCopy: QuickActionsCopy = {
    loading: 'Working…',
    empty: 'No actions available right now.',
    errorFallback: "That action couldn't be completed.",
  };
  readonly copy = computed<QuickActionsCopy>(() => ({ ...this.defaultCopy, ...this.states() }));

  /** Merge authored props with the resolved runtime projection (same authored order). */
  readonly view = computed<ActionVM[]>(() => {
    const rt = this.runtime();
    return this.actions().map((a, index) => {
      const r = rt?.[index] ?? {};
      return {
        ...a,
        index,
        kind: a.tool ? 'tool' : 'prompt',
        enabled: r.enabled ?? true,
        pending: r.pending ?? false,
        readonly: r.readonly ?? false,
        writer: r.writer,
      } satisfies ActionVM;
    });
  });

  /** Explicit `grid-template-columns` only when layout=grid AND a column count was given. */
  readonly gridStyle = computed<string | null>(() => {
    if (this.layout() !== 'grid') return null;
    const cols = this.columns();
    return cols && cols > 0 ? `repeat(${cols}, minmax(0, 1fr))` : null;
  });

  constructor() {
    // Move focus into the confirmation step when it opens (first-party dialog behaviour).
    effect(() => {
      const open = this.confirming();
      const btn = this.confirmBtn();
      if (open !== null && btn) btn.nativeElement.focus();
    });
  }

  isConfirming(index: number): boolean {
    return this.confirming() === index;
  }

  activate(a: ActionVM, ev: Event): void {
    // aria-disabled buttons stay focusable but are NOT activatable (schema actionRuntime.enabled).
    if (!a.enabled || a.pending) return;
    if (this.confirming() === a.index) return; // dialog already open — use its buttons
    if (a.confirm) {
      this.returnFocusEl = ev.currentTarget as HTMLElement | null;
      this.confirming.set(a.index);
      return;
    }
    this.emit(a);
  }

  confirmYes(a: ActionVM): void {
    this.confirming.set(null);
    this.restoreFocus();
    this.emit(a);
  }

  confirmCancel(): void {
    this.confirming.set(null);
    this.restoreFocus();
  }

  onConfirmKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      this.confirmCancel();
    }
  }

  /** Re-invoke the action that failed (inline retry in the error phase). */
  retryFailed(): void {
    const id = this.error()?.action_id;
    const target = this.view().find((a) => a.id === id);
    if (target) this.emit(target);
  }

  onDismiss(): void {
    this.dismiss.emit();
  }

  private emit(a: ActionVM): void {
    this.invoke.emit({
      index: a.index,
      id: a.id,
      kind: a.kind,
      label: a.label,
      tool: a.tool,
      prompt: a.prompt,
    });
  }

  private restoreFocus(): void {
    const el = this.returnFocusEl;
    this.returnFocusEl = null;
    if (el) queueMicrotask(() => el.focus());
  }
}
