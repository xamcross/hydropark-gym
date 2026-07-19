import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
} from '@angular/core';

/**
 * slider / stepper — the numeric-scalar input widget (SPEC §9.4, P1-06.4).
 *
 * One contract, both first-party presentations of the same bounded number, kept
 * in perfect sync: a continuous `<input type="range">` slider AND a discrete
 * stepper (−/＋ buttons around a value field). The manifest normally selects one
 * presentation via `type` (`slider` | `stepper`); this component can render
 * either or `both` (default) so the two stay wired to a single value.
 *
 * Bound two-way to a `scalar<number>` slot: user edits emit `value_changed`
 * (contract dir 1 — the renderer writes the slot; the new value flows back in via
 * the `value` input and reconciles). When the owning skill is NOT the slot's
 * writer-of-record, `readonly` resolves true at merge (contract §5): every edit
 * affordance disables and the writer is named.
 *
 * Implements the mandatory loading / empty / error lifecycle (contract §6),
 * read-only behavior (§5), the mechanical a11y contract (§8 — role=slider /
 * spinbutton, aria-value*, keyboard arrows/page/home/end, no hue-only meaning),
 * and token-only styling (§7). Inputs mirror slider_stepper.schema.json `props`
 * + `$defs/runtimeState`; outputs mirror its `emits`.
 */

export type SliderPhase = 'loading' | 'empty' | 'ready' | 'error';
export type SliderPresentation = 'slider' | 'stepper' | 'both';

/** The slot's writer-of-record when this skill is NOT it (runtimeState.writer). */
export interface SliderWriter {
  skill_id?: string;
  name: string;
}

/** Per-instance copy overrides for the mandatory states (base `states`). */
export interface SliderStateCopy {
  loading?: { label?: string };
  empty?: { label?: string; hint?: string };
  error?: { label?: string; hint?: string };
}

let uid = 0;

@Component({
  selector: 'app-slider-stepper',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './slider-stepper.component.html',
  styleUrl: './slider-stepper.component.css',
})
export class SliderStepperComponent {
  // --- props (slider_stepper.schema.json#/properties/props) --------------------
  readonly min = input.required<number>();
  readonly max = input.required<number>();
  readonly step = input<number>(1);
  readonly pageStep = input<number | null>(null); // props.page_step
  readonly defaultValue = input<number | null>(null); // props.default_value
  readonly unitLabel = input<string>(''); // props.unit_label
  readonly decimals = input<number | null>(null); // props.decimals
  readonly showValue = input<boolean>(true); // props.show_value
  readonly marks = input<boolean>(false); // props.marks (slider only)
  readonly clamp = input<boolean>(true); // props.clamp
  readonly commitOn = input<'change' | 'release'>('release'); // props.commit_on
  readonly presentation = input<SliderPresentation>('both'); // schema `type`

  // --- envelope (base) ---------------------------------------------------------
  readonly title = input<string>('Value'); // base `title` (heading + accessible name)
  readonly states = input<SliderStateCopy | null>(null); // base `states`

  // --- runtime state (schema#/$defs/runtimeState) ------------------------------
  readonly value = input<number | null>(null); // committed slot value
  readonly phase = input<SliderPhase>('ready'); // externally-driven lifecycle
  readonly readonly = input<boolean>(false); // resolved at merge (contract §5)
  readonly writer = input<SliderWriter | null>(null); // writer-of-record when read-only

  // --- events (schema#/properties/emits) ---------------------------------------
  readonly valueChanged = output<number>(); // `value_changed`
  readonly limitReached = output<'min' | 'max'>(); // `limit_reached`

  // --- local model: the display source of truth, reconciled from `value` -------
  private readonly model = signal<number | null>(null);
  private readonly instanceId = ++uid;

  readonly fieldId = `slider-stepper-${this.instanceId}`;
  readonly managedId = `slider-stepper-managed-${this.instanceId}`;
  readonly rangeId = `slider-stepper-range-${this.instanceId}`;

  constructor() {
    // Reconcile the local model whenever the authoritative slot value changes.
    // In the wired app the committed value flows back after `value_changed`; in
    // isolation the model simply retains the user's edits (value never changes).
    effect(() => this.model.set(this.value()));
  }

  // --- derived formatting ------------------------------------------------------
  readonly resolvedDecimals = computed(() => {
    const explicit = this.decimals();
    if (explicit != null) return explicit;
    const s = this.step();
    if (Number.isInteger(s)) return 0;
    const text = String(s);
    const dot = text.indexOf('.');
    return dot < 0 ? 0 : text.length - dot - 1;
  });

  readonly resolvedPageStep = computed(() => {
    const explicit = this.pageStep();
    if (explicit != null && explicit > 0) return explicit;
    return Math.max(this.step(), Math.round((this.max() - this.min()) / 10));
  });

  private clampToRange(v: number): number {
    return Math.min(this.max(), Math.max(this.min(), v));
  }

  private format(v: number): string {
    return v.toFixed(this.resolvedDecimals());
  }

  /** Value the controls render at (clamped into [min,max]). */
  readonly displayValue = computed(() =>
    this.clampToRange(this.model() ?? this.defaultValue() ?? this.min())
  );

  readonly displayText = computed(() => this.format(this.displayValue()));

  /** Announced text — always carries the unit so SR never reads a bare number. */
  readonly valueText = computed(() => {
    const unit = this.unitLabel().trim();
    return unit ? `${this.displayText()} ${unit}` : this.displayText();
  });

  // --- lifecycle (contract §6) -------------------------------------------------
  /** The incoming committed value fell outside [min,max]. */
  readonly committedOutOfRange = computed(() => {
    const v = this.value();
    return v !== null && (v < this.min() || v > this.max());
  });

  readonly effectivePhase = computed<SliderPhase>(() => {
    const p = this.phase();
    if (p === 'loading') return 'loading';
    if (p === 'error') return 'error';
    // clamp=false + out-of-range surfaces the mandatory error state (§6).
    if (this.committedOutOfRange() && !this.clamp()) return 'error';
    const hasValue = this.model() !== null || this.defaultValue() !== null;
    return hasValue ? 'ready' : 'empty';
  });

  /** clamp=true + out-of-range: display clamped and flag it (text + icon, §8). */
  readonly showClampBadge = computed(() => this.committedOutOfRange() && this.clamp());

  // --- disabled / boundary state ----------------------------------------------
  readonly controlDisabled = computed(
    () => this.readonly() || this.effectivePhase() === 'loading'
  );
  readonly atMin = computed(() => this.displayValue() <= this.min());
  readonly atMax = computed(() => this.displayValue() >= this.max());
  readonly decDisabled = computed(() => this.controlDisabled() || this.atMin());
  readonly incDisabled = computed(() => this.controlDisabled() || this.atMax());

  readonly showSlider = computed(() => this.presentation() !== 'stepper');
  readonly showStepper = computed(() => this.presentation() !== 'slider');
  readonly managedBy = computed(() => this.writer()?.name ?? '');

  // --- state copy --------------------------------------------------------------
  readonly loadingLabel = computed(() => this.states()?.loading?.label ?? 'Loading…');
  readonly emptyLabel = computed(() => this.states()?.empty?.label ?? 'Not set');
  readonly emptyHint = computed(
    () => this.states()?.empty?.hint ?? 'Choose a value to begin.'
  );
  readonly errorLabel = computed(() => this.states()?.error?.label ?? 'Value out of range');
  readonly errorHint = computed(
    () =>
      this.states()?.error?.hint ??
      'Enter a number between the minimum and maximum.'
  );

  // --- tick marks (slider presentation only) -----------------------------------
  readonly ticks = computed<{ value: number; pct: number }[]>(() => {
    if (!this.marks() || !this.showSlider()) return [];
    const min = this.min();
    const max = this.max();
    const span = max - min;
    if (span <= 0) return [];
    const step = this.step();
    const stepCount = Math.floor(span / step);
    // Cap the DOM: dense ranges fall back to 10 evenly-spaced ticks.
    const count = stepCount <= 0 ? 1 : stepCount > 20 ? 10 : stepCount;
    const out: { value: number; pct: number }[] = [];
    for (let i = 0; i <= count; i++) {
      const value = count === stepCount ? min + step * i : min + (span * i) / count;
      out.push({ value, pct: ((value - min) / span) * 100 });
    }
    return out;
  });

  readonly minLabel = computed(() => this.format(this.min()));
  readonly maxLabel = computed(() => this.format(this.max()));

  // --- interaction -------------------------------------------------------------
  private emit(v: number): void {
    this.model.set(v);
    this.valueChanged.emit(v);
  }

  onSliderInput(raw: string): void {
    const v = this.clampToRange(Number(raw));
    this.model.set(v);
    if (this.commitOn() === 'change') this.valueChanged.emit(v);
  }

  onSliderChange(raw: string): void {
    const v = this.clampToRange(Number(raw));
    this.model.set(v);
    // In `release` mode the commit happens here; in `change` mode `input`
    // already emitted each intermediate value, so avoid a duplicate.
    if (this.commitOn() === 'release') this.valueChanged.emit(v);
  }

  /** Emit limit_reached when a keyboard nudge is refused at a boundary (§8). */
  onSliderKeydown(event: KeyboardEvent): void {
    if (this.controlDisabled()) return;
    const decrement = ['ArrowLeft', 'ArrowDown', 'PageDown', 'Home'];
    const increment = ['ArrowRight', 'ArrowUp', 'PageUp', 'End'];
    if (decrement.includes(event.key) && this.atMin()) this.limitReached.emit('min');
    else if (increment.includes(event.key) && this.atMax()) this.limitReached.emit('max');
  }

  stepBy(direction: 1 | -1): void {
    if (this.controlDisabled()) return;
    const current = this.displayValue();
    const next = this.clampToRange(current + direction * this.step());
    if (next === current) {
      this.limitReached.emit(direction === 1 ? 'max' : 'min');
      return;
    }
    this.emit(next);
  }

  pageBy(direction: 1 | -1): void {
    if (this.controlDisabled()) return;
    const current = this.displayValue();
    const next = this.clampToRange(current + direction * this.resolvedPageStep());
    if (next === current) {
      this.limitReached.emit(direction === 1 ? 'max' : 'min');
      return;
    }
    this.emit(next);
  }

  onNumberChange(el: HTMLInputElement): void {
    if (this.controlDisabled()) return;
    const raw = el.value;
    // Empty / non-numeric entry: revert the field to the current model value.
    if (raw.trim() === '' || Number.isNaN(Number(raw))) {
      el.value = String(this.displayValue());
      return;
    }
    const parsed = Number(raw);
    const clamped = this.clampToRange(parsed);
    if (clamped !== parsed) this.limitReached.emit(parsed < this.min() ? 'min' : 'max');
    this.emit(clamped);
    // Reflect the clamped model even when the [value] binding is unchanged
    // (e.g. typing 999 against a max already at the model value).
    el.value = String(this.displayValue());
  }

  /** Keyboard on the stepper value field: PageUp/Down use page_step (§8). */
  onNumberKeydown(event: KeyboardEvent): void {
    if (this.controlDisabled()) return;
    switch (event.key) {
      case 'ArrowUp':
        event.preventDefault();
        this.stepBy(1);
        break;
      case 'ArrowDown':
        event.preventDefault();
        this.stepBy(-1);
        break;
      case 'PageUp':
        event.preventDefault();
        this.pageBy(1);
        break;
      case 'PageDown':
        event.preventDefault();
        this.pageBy(-1);
        break;
      case 'Home':
        event.preventDefault();
        this.emit(this.min());
        break;
      case 'End':
        event.preventDefault();
        this.emit(this.max());
        break;
      default:
        break;
    }
  }
}
