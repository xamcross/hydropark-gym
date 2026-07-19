import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  OnChanges,
  OnInit,
  Output,
} from '@angular/core';

/* -----------------------------------------------------------------------------
 * progress widget (P1-06.4x) — a pure OUTPUT indicator for downloads / long tasks.
 * Conforms to contracts/widgets/progress.schema.json + _widget-contract.md.
 *
 * Two modes:
 *   - determinate   → a bound scalar<number> read as a fraction, clamped to [0,1]
 *   - indeterminate → a bound scalar<bool> busy flag (true = busy, false = done)
 * `mode:auto` derives the mode from which input is driving.
 *
 * ARIA: role="progressbar" with aria-valuemin/max/now (fraction) + aria-valuetext
 * ("45%") when determinate; aria-valuenow OMITTED and aria-busy=true when
 * indeterminate. Magnitude is conveyed by FILL EXTENT + percent/"Working…"/"Done"
 * TEXT — never by hue alone (WCAG 1.4.1). Milestone announcements are throttled
 * (25% buckets + completion) to avoid screen-reader spam.
 *
 * Fed via @Input; the later gallery/registration ticket wires it to the bus.
 * -------------------------------------------------------------------------- */

export type ProgressMode = 'auto' | 'determinate' | 'indeterminate';
export type ProgressShape = 'bar' | 'ring';
export type ProgressValueDisplay = 'percent' | 'none';
export type ProgressLifecycle = 'loading' | 'ready' | 'empty' | 'error';

export type WidgetTone = 'default' | 'neutral' | 'accent' | 'positive' | 'caution' | 'danger';
export type WidgetEmphasis = 'subtle' | 'normal' | 'strong';
export type WidgetDensity = 'comfortable' | 'compact';
export type WidgetAlign = 'start' | 'center' | 'end';

export interface WidgetStyle {
  tone?: WidgetTone;
  emphasis?: WidgetEmphasis;
  density?: WidgetDensity;
  align?: WidgetAlign;
}

export interface WidgetError {
  message: string;
  retryable?: boolean;
}

export interface ProgressStateCopy {
  loading?: string;
  empty?: string;
  error?: string;
}

@Component({
  selector: 'app-progress',
  standalone: true,
  templateUrl: './progress.component.html',
  styleUrl: './progress.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProgressComponent implements OnInit, OnChanges {
  // --- envelope + props (schema $defs/progressProps) ---
  @Input() title?: string;
  @Input() mode: ProgressMode = 'auto';
  @Input() shape: ProgressShape = 'bar';
  @Input() valueDisplay: ProgressValueDisplay = 'percent';
  @Input() caption?: string;
  @Input() cancelable = false;
  @Input() style: WidgetStyle = {};
  @Input() states: ProgressStateCopy = {};
  @Input() liveRegion: 'polite' | 'assertive' | 'off' = 'polite';

  // --- runtime state (schema $defs/runtimeBehavior) ---
  /** Determinate fraction in [0,1]; null while waiting for the first value. */
  @Input() value: number | null = null;
  /** Indeterminate busy flag (true = busy, false = idle/done). */
  @Input() busy = false;
  @Input() lifecycle: ProgressLifecycle = 'ready';
  @Input() readonly = false;
  @Input() writer: string | null = null;
  @Input() error: WidgetError | null = null;

  // --- events (schema `emits` = ["completed"]) ---
  /** Edge-triggered: determinate value reaches >= 1, or busy true -> false. */
  @Output() completed = new EventEmitter<void>();
  /** Direction-2 cancel: deterministically invokes the bound tool (props.cancelable). */
  @Output() cancel = new EventEmitter<void>();
  /** Mechanical recovery affordance for the error state (contract §6) — not a skill event. */
  @Output() retry = new EventEmitter<void>();

  // --- derived view model ---
  effectiveMode: 'determinate' | 'indeterminate' = 'indeterminate';
  clamped = 0;
  percent = 0;
  resolved: 'loading' | 'error' | 'empty' | 'ready' = 'ready';
  liveText = '';

  private wasComplete = false;
  private wasBusy = false;
  private liveBucket = -1;

  ngOnInit(): void {
    this.recompute();
  }

  ngOnChanges(): void {
    this.recompute();
  }

  workingLabel(): string {
    return 'Working…';
  }

  doneLabel(): string {
    return 'Done';
  }

  onCancel(): void {
    if (this.readonly) return; // read-only: cancel would set a slot this skill doesn't own (§5)
    this.cancel.emit();
  }

  // --- internals ---------------------------------------------------------

  private recompute(): void {
    this.effectiveMode = this.resolveMode();
    this.clamped = this.value === null ? 0 : Math.max(0, Math.min(1, this.value));
    this.percent = Math.round(this.clamped * 100);
    this.resolved = this.resolveState();
    this.detectCompletionAndAnnounce();
  }

  private resolveMode(): 'determinate' | 'indeterminate' {
    if (this.mode === 'determinate') return 'determinate';
    if (this.mode === 'indeterminate') return 'indeterminate';
    // auto: infer from the bound scalar kind (number -> determinate, bool -> indeterminate)
    return this.value !== null ? 'determinate' : 'indeterminate';
  }

  private resolveState(): 'loading' | 'error' | 'empty' | 'ready' {
    if (this.lifecycle === 'loading') return 'loading';
    if (this.lifecycle === 'error') return 'error';
    if (this.lifecycle === 'empty') return 'empty';
    // determinate with no value yet = "Waiting to start." (schema runtimeBehavior)
    if (this.effectiveMode === 'determinate' && this.value === null) return 'empty';
    return 'ready';
  }

  /** Edge-triggered `completed` + throttled milestone announcements. */
  private detectCompletionAndAnnounce(): void {
    if (this.effectiveMode === 'determinate') {
      const complete = this.value !== null && this.clamped >= 1;
      if (complete && !this.wasComplete) this.completed.emit();
      this.wasComplete = complete;

      const bucket = complete ? 4 : Math.floor(this.percent / 25);
      if (bucket !== this.liveBucket) {
        this.liveBucket = bucket;
        this.liveText = complete ? this.doneLabel() : `${this.percent}%`;
      }
    } else {
      if (this.wasBusy && !this.busy) {
        this.completed.emit();
        this.liveText = this.doneLabel();
      } else if (this.busy && this.liveText !== this.workingLabel()) {
        this.liveText = this.workingLabel();
      }
      this.wasBusy = this.busy;
    }
  }
}
