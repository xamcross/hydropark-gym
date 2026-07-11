import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  LOCALE_ID,
  output,
  signal,
} from '@angular/core';

/**
 * date_time_picker — locale-aware date / time / date-time selection (SPEC §9.4,
 * P1-06.4). Bound two-way to a single `scalar<string>` slot holding a
 * LOCALE-NEUTRAL ISO 8601 value (see date_time_picker.schema.json#/$defs/
 * dateTimeValue): mode=date → `YYYY-MM-DD`, mode=time → `HH:mm[:ss]`,
 * mode=datetime → `YYYY-MM-DDTHH:mm[:ss]`. Only the PRESENTATION is localized.
 *
 * Editing uses the platform date/time controls (`<input type="date|time|
 * datetime-local">`): they render in the user's locale, are keyboard-operable
 * and screen-reader-labelled, produce ISO-shaped values, and enforce min/max —
 * meeting the mechanical a11y bar (contract §8) without a hand-rolled calendar
 * grid. A human-readable preview is formatted with `Intl.DateTimeFormat` at the
 * resolved locale (never hardcoded — it flows from the `locale` input or the
 * app's `LOCALE_ID`), honouring `hour_cycle` / `time_granularity`.
 *
 * Implements the mandatory loading / empty / error lifecycle (contract §6),
 * read-only behavior (§5 — disable all affordances, name the writer), and
 * token-only styling (§7). Inputs mirror the schema `props` + runtime-state
 * projection; outputs mirror `emits` (`value_committed`, `cleared`).
 */

export type DateTimeMode = 'date' | 'time' | 'datetime';
export type DateTimePhase = 'loading' | 'empty' | 'ready' | 'error';
export type TimeGranularity = 'hour' | 'minute' | 'second';
export type HourCycle = 'locale' | 'h12' | 'h24';
export type WeekStart = 'locale' | 'saturday' | 'sunday' | 'monday';

export interface DateTimeStateCopy {
  loading?: { label?: string };
  empty?: { label?: string; hint?: string };
  error?: { label?: string; hint?: string };
}

let uid = 0;

@Component({
  selector: 'app-date-time-picker',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './date-time-picker.component.html',
  styleUrl: './date-time-picker.component.css',
})
export class DateTimePickerComponent {
  // --- props (date_time_picker.schema.json#/properties/props) ------------------
  readonly mode = input<DateTimeMode>('date');
  readonly timeGranularity = input<TimeGranularity>('minute'); // props.time_granularity
  readonly minuteStep = input<number>(1); // props.minute_step
  readonly hourCycle = input<HourCycle>('locale'); // props.hour_cycle
  readonly weekStart = input<WeekStart>('locale'); // props.week_start (presentation-only; native derives from locale)
  readonly min = input<string | null>(null); // props.min: ISO | 'now' | 'today'
  readonly max = input<string | null>(null); // props.max: ISO | 'now' | 'today'
  readonly clearable = input<boolean>(true); // props.clearable
  readonly nowShortcut = input<boolean>(true); // props.now_shortcut
  readonly placeholder = input<string>(''); // props.placeholder

  // --- envelope (base) ---------------------------------------------------------
  readonly title = input<string>('Date'); // base `title` (heading + accessible name)
  readonly locale = input<string | null>(null); // BCP-47 override; null → LOCALE_ID
  readonly states = input<DateTimeStateCopy | null>(null); // base `states`

  // --- runtime state (schema#/$defs/runtimeStateProjection) --------------------
  readonly value = input<string | null>(null); // committed ISO slot value
  readonly phase = input<DateTimePhase>('ready');
  readonly readonly = input<boolean>(false); // resolved at merge (contract §5)
  readonly writer = input<string | null>(null); // writer-of-record name when read-only

  // --- events (schema#/properties/emits) ---------------------------------------
  readonly valueCommitted = output<string>(); // `value_committed`
  readonly cleared = output<void>(); // `cleared`

  private readonly runtimeLocale = inject(LOCALE_ID);
  private readonly model = signal<string | null>(null);
  private readonly instanceId = ++uid;

  readonly fieldId = `date-time-picker-${this.instanceId}`;
  readonly managedId = `date-time-picker-managed-${this.instanceId}`;
  readonly readoutId = `date-time-picker-readout-${this.instanceId}`;

  constructor() {
    // Reconcile the local model from the authoritative slot value (contract dir
    // 1): a committed selection flows back in via `value`; in isolation the
    // model simply retains the user's choice.
    effect(() => this.model.set(this.value()));
  }

  readonly resolvedLocale = computed(() => this.locale() ?? this.runtimeLocale);

  // --- native control wiring ---------------------------------------------------
  readonly nativeInputType = computed(() => {
    const m = this.mode();
    return m === 'date' ? 'date' : m === 'time' ? 'time' : 'datetime-local';
  });

  readonly hasTime = computed(() => this.mode() !== 'date');
  readonly hasDate = computed(() => this.mode() !== 'time');

  /** Native `step` (seconds) for time / datetime; null for date-only. */
  readonly nativeStep = computed<number | null>(() => {
    if (!this.hasTime()) return null;
    switch (this.timeGranularity()) {
      case 'hour':
        return 3600;
      case 'second':
        return 1;
      default:
        return Math.max(1, this.minuteStep()) * 60;
    }
  });

  private pad(n: number): string {
    return String(n).padStart(2, '0');
  }

  private hasZone(iso: string): boolean {
    return iso.includes('T') && /(?:Z|[+-]\d{2}:\d{2})$/.test(iso);
  }

  private formatLocalDateTime(d: Date): string {
    const date = `${d.getFullYear()}-${this.pad(d.getMonth() + 1)}-${this.pad(d.getDate())}`;
    const time = `${this.pad(d.getHours())}:${this.pad(d.getMinutes())}`;
    const withSec = this.timeGranularity() === 'second' ? `:${this.pad(d.getSeconds())}` : '';
    return `${date}T${time}${withSec}`;
  }

  /** Stored ISO → the native input's expected value string. */
  private toNative(iso: string | null): string {
    if (!iso) return '';
    const m = this.mode();
    if (m === 'date') return iso.slice(0, 10);
    if (m === 'time') {
      const withSec = this.timeGranularity() === 'second';
      return iso.slice(0, withSec ? 8 : 5);
    }
    // datetime — normalize any zoned value to local wall-clock (datetime-local
    // carries no offset); a bare value is already local.
    if (this.hasZone(iso)) {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return '';
      return this.formatLocalDateTime(d);
    }
    return iso.slice(0, this.timeGranularity() === 'second' ? 19 : 16);
  }

  /** Native input value → stored ISO (applying hour granularity). */
  private fromNative(raw: string): string {
    const m = this.mode();
    if (m === 'date') return raw;
    if (m === 'time') return this.applyGranularity(raw);
    // datetime: 'YYYY-MM-DDTHH:mm[:ss]'
    const tIndex = raw.indexOf('T');
    if (tIndex < 0) return raw;
    const datePart = raw.slice(0, tIndex);
    return `${datePart}T${this.applyGranularity(raw.slice(tIndex + 1))}`;
  }

  private applyGranularity(timePart: string): string {
    const [hh = '00', mm = '00', ss] = timePart.split(':');
    if (this.timeGranularity() === 'hour') return `${hh}:00`;
    if (this.timeGranularity() === 'second') return `${hh}:${mm}:${ss ?? '00'}`;
    return `${hh}:${mm}`;
  }

  readonly nativeValue = computed(() => this.toNative(this.model()));

  /** Current instant in the mode's ISO shape (local wall-clock). */
  private nowIso(): string {
    const d = new Date();
    const date = `${d.getFullYear()}-${this.pad(d.getMonth() + 1)}-${this.pad(d.getDate())}`;
    const minutes = this.timeGranularity() === 'hour' ? '00' : this.pad(d.getMinutes());
    const seconds = this.timeGranularity() === 'second' ? `:${this.pad(d.getSeconds())}` : '';
    const time = `${this.pad(d.getHours())}:${minutes}${seconds}`;
    const m = this.mode();
    return m === 'date' ? date : m === 'time' ? time : `${date}T${time}`;
  }

  /** Resolve a `min`/`max` bound (ISO | 'now' | 'today') to a native string. */
  private resolveBound(bound: string | null): string | null {
    if (!bound) return null;
    if (bound === 'now') return this.toNative(this.nowIso());
    if (bound === 'today') {
      const d = new Date();
      return this.toNative(`${d.getFullYear()}-${this.pad(d.getMonth() + 1)}-${this.pad(d.getDate())}`);
    }
    return this.toNative(bound);
  }

  readonly nativeMin = computed(() => this.resolveBound(this.min()));
  readonly nativeMax = computed(() => this.resolveBound(this.max()));

  /** Fixed-width native strings compare lexicographically == chronologically. */
  readonly inRange = computed(() => {
    const nv = this.nativeValue();
    if (!nv) return true;
    const lo = this.nativeMin();
    const hi = this.nativeMax();
    if (lo && nv < lo) return false;
    if (hi && nv > hi) return false;
    return true;
  });

  // --- lifecycle (contract §6) -------------------------------------------------
  readonly effectivePhase = computed<DateTimePhase>(() => {
    const p = this.phase();
    if (p === 'loading') return 'loading';
    if (p === 'error') return 'error';
    if (this.model() !== null && !this.inRange()) return 'error';
    return this.model() === null ? 'empty' : 'ready';
  });

  readonly showClear = computed(
    () => this.clearable() && !this.readonly() && this.model() !== null
  );
  readonly showNow = computed(() => this.nowShortcut() && !this.readonly());
  readonly managedBy = computed(() => this.writer() ?? '');

  // --- locale-aware readable preview (Intl — never a hardcoded locale) ---------
  private buildIntlOptions(): Intl.DateTimeFormatOptions {
    const opts: Intl.DateTimeFormatOptions = {};
    if (this.hasDate()) {
      opts.year = 'numeric';
      opts.month = 'long';
      opts.day = 'numeric';
      if (this.mode() === 'datetime') opts.weekday = 'short';
    }
    if (this.hasTime()) {
      opts.hour = 'numeric';
      opts.minute = '2-digit';
      if (this.timeGranularity() === 'second') opts.second = '2-digit';
      const hc = this.hourCycle();
      if (hc === 'h12') opts.hour12 = true;
      else if (hc === 'h24') opts.hour12 = false;
    }
    return opts;
  }

  private parseToDate(iso: string): Date | null {
    const m = this.mode();
    if (m === 'date') {
      const [y, mo, d] = iso.slice(0, 10).split('-').map(Number);
      return new Date(y, (mo ?? 1) - 1, d ?? 1);
    }
    if (m === 'time') {
      const [hh, mm, ss] = iso.split(':').map(Number);
      const n = new Date();
      return new Date(n.getFullYear(), n.getMonth(), n.getDate(), hh ?? 0, mm ?? 0, ss ?? 0);
    }
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  readonly displayText = computed(() => {
    const v = this.model();
    if (!v) return '';
    const d = this.parseToDate(v);
    if (!d) return '';
    try {
      return new Intl.DateTimeFormat(this.resolvedLocale(), this.buildIntlOptions()).format(d);
    } catch {
      return v; // never crash on a malformed value — fall back to the raw ISO
    }
  });

  readonly nowLabel = computed(() => (this.mode() === 'date' ? 'Today' : 'Now'));

  // --- state copy --------------------------------------------------------------
  readonly loadingLabel = computed(() => this.states()?.loading?.label ?? 'Loading…');
  readonly emptyLabel = computed(() => this.states()?.empty?.label ?? 'No date selected.');
  readonly errorLabel = computed(
    () => this.states()?.error?.label ?? "Couldn't set the date — check the value."
  );
  readonly errorHint = computed(() => this.states()?.error?.hint ?? '');

  // --- interaction -------------------------------------------------------------
  onNativeChange(raw: string): void {
    if (this.readonly()) return;
    if (raw.trim() === '') {
      // The native control was cleared.
      if (this.clearable()) this.clearSelection();
      return;
    }
    const iso = this.fromNative(raw);
    this.model.set(iso);
    this.valueCommitted.emit(iso);
  }

  setNow(): void {
    if (this.readonly()) return;
    let iso = this.nowIso();
    const lo = this.nativeMin();
    const hi = this.nativeMax();
    const native = this.toNative(iso);
    // Respect bounds (schema: snap "respecting min/max").
    if (lo && native < lo) iso = this.fromNative(lo);
    else if (hi && native > hi) iso = this.fromNative(hi);
    this.model.set(iso);
    this.valueCommitted.emit(iso);
  }

  clearSelection(): void {
    if (this.readonly() || !this.clearable()) return;
    this.model.set(null);
    this.cleared.emit();
  }
}
