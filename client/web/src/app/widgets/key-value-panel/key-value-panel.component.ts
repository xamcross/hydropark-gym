import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  OnChanges,
  OnInit,
  Output,
} from '@angular/core';
import { BoundState } from '../widget-contract';

/* -----------------------------------------------------------------------------
 * key_value_panel widget (P1-06.4x) — a labeled, typed key/value readout.
 * Conforms to contracts/widgets/key_value_panel.schema.json + _widget-contract.md.
 *
 * DISPLAY-ONLY: it never edits its bound slot from user input, so it renders live
 * in every case; the writer-of-record distinction (contract §5) affects only how
 * PROVENANCE is surfaced (`Values from {writer}`), never whether controls exist.
 *
 * Fed via @Input (the later gallery/registration ticket wires it to the bus):
 *   - props            → schema `props` (fields/columns/value_align/on_missing/…)
 *   - runtime state    → schema $defs/runtimeState (lifecycle/values/readonly/…)
 *   - @Output events   → schema `emits` (field_activated / value_copied), plus a
 *                        mechanical `retry` recovery affordance (contract §6).
 *
 * BOUND STATE (P1-06.1 · contract §5 · F08): two mount modes, SELECTED BY THE
 * HOST, mirroring `editable_list`/`table`:
 *  - SELF-SOURCED (`bound` absent): renders the declared `fields`/`values` props
 *    exactly as authored — unchanged from before this ticket.
 *  - BOUND (composed-panel-host, `bound` set): renders rows derived LIVE from the
 *    bound slot's own value, and takes its read-only verdict + writer attribution
 *    from it (§5's "Managed by {writer}" affordance, already in the template).
 *    The derivation is DELIBERATELY HONEST — it never invents a number: a `list`
 *    slot (e.g. the shared `ingredients` list) yields a live tracked-count row
 *    plus one row per item's own name; a `record` slot echoes its own fields; a
 *    `scalar` slot echoes its own value. No calorie/macro/health figure is ever
 *    synthesized here — nutrition is informational-only and safety-sensitive
 *    (SPEC §28.1); a skill that wants real macro figures must compute and hand
 *    them over as its OWN typed `values`/`fields` (the self-sourced path above),
 *    never have this widget guess them from a raw ingredient list.
 * -------------------------------------------------------------------------- */

export type KvValueType =
  | 'text'
  | 'number'
  | 'integer'
  | 'percent'
  | 'currency'
  | 'duration'
  | 'bytes'
  | 'datetime'
  | 'date'
  | 'time'
  | 'bool'
  | 'enum';

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

/** One labeled, typed row (schema $defs/fieldSpec). */
export interface KvFieldSpec {
  key: string;
  label?: string;
  value_type?: KvValueType;
  unit?: string;
  precision?: number;
  currency_code?: string;
  enum_labels?: Record<string, string>;
  bool_labels?: { true?: string; false?: string };
  tone?: WidgetTone;
  emphasis?: WidgetEmphasis;
  hide_when_empty?: boolean;
}

/** One resolved value handed over as runtime state (schema $defs/typedValue). */
export interface KvTypedValue {
  type?: KvValueType;
  raw?: number | string | boolean | null;
  display?: string | null;
  present?: boolean;
}

export type KvLifecycle = 'loading' | 'ready' | 'empty' | 'error' | 'readonly' | 'placeholder';

export interface WidgetError {
  message: string;
  retryable?: boolean;
}

/** Copy overrides for the mandatory states (envelope `states`, contract §6). */
export interface KvStateCopy {
  loading?: string;
  empty?: string;
  error?: string;
}

/** What the template actually iterates. */
interface KvRow {
  key: string;
  label: string;
  display: string;
  present: boolean;
  tone: WidgetTone | null;
  emphasis: WidgetEmphasis | null;
}

type ResolvedState = 'loading' | 'error' | 'placeholder' | 'empty' | 'populated';

@Component({
  selector: 'app-key-value-panel',
  standalone: true,
  templateUrl: './key-value-panel.component.html',
  styleUrl: './key-value-panel.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class KeyValuePanelComponent implements OnInit, OnChanges {
  // --- envelope + props (schema `props`) ---
  @Input() title?: string;
  @Input() fields: KvFieldSpec[] = [];
  @Input() columns = 1;
  @Input() valueAlign: WidgetAlign = 'end';
  @Input() onMissing: 'dash' | 'hide' = 'dash';
  @Input() selectableValues = true;
  @Input() caption?: string;
  @Input() style: WidgetStyle = {};
  @Input() states: KvStateCopy = {};
  @Input() liveRegion: 'polite' | 'assertive' | 'off' = 'polite';

  /**
   * True when the owning skill declared a `binds_tool` — rows become activatable
   * (direction 2, UI-first). With no tool the readout stays non-interactive and
   * emits nothing (schema default event set is empty).
   */
  @Input() interactive = false;

  // --- runtime state (schema $defs/runtimeState) ---
  @Input() lifecycle: KvLifecycle = 'ready';
  @Input() values: Record<string, KvTypedValue> = {};
  @Input() readonly = false;
  @Input() writer: string | null = null;
  @Input() error: WidgetError | null = null;

  /**
   * The read-only-aware slot binding (contract §5 · P1-06.1). Absent ⇒ the
   * self-sourced mount above (declared `fields`/`values` props, unchanged);
   * present ⇒ render rows derived LIVE from the bound slot's own value — see
   * the class doc for exactly what gets derived and why nothing is invented.
   */
  @Input() bound: BoundState<unknown> | null = null;

  // --- events (schema `emits`) ---
  @Output() fieldActivated = new EventEmitter<{ key: string }>();
  @Output() valueCopied = new EventEmitter<{ key: string }>();
  /** Mechanical recovery affordance for the error state (contract §6) — not a skill event. */
  @Output() retry = new EventEmitter<void>();

  // --- derived view model ---
  rows: KvRow[] = [];
  resolved: ResolvedState = 'empty';

  ngOnInit(): void {
    this.recompute();
  }

  ngOnChanges(): void {
    this.recompute();
  }

  activate(key: string): void {
    if (!this.interactive) return;
    this.fieldActivated.emit({ key });
  }

  onSpace(event: Event, key: string): void {
    if (!this.interactive) return;
    event.preventDefault();
    this.fieldActivated.emit({ key });
  }

  onCopy(key: string): void {
    if (!this.selectableValues) return;
    this.valueCopied.emit({ key });
  }

  // --- internals ---------------------------------------------------------

  private recompute(): void {
    if (this.lifecycle === 'loading') {
      this.resolved = 'loading';
      this.rows = [];
      return;
    }
    if (this.lifecycle === 'error') {
      this.resolved = 'error';
      this.rows = [];
      return;
    }
    if (this.lifecycle === 'placeholder') {
      this.resolved = 'placeholder';
      this.rows = [];
      return;
    }

    if (this.bound) {
      this.recomputeBound(this.bound);
      return;
    }

    this.rows = this.buildRows();
    this.resolved = this.lifecycle === 'empty' || this.rows.length === 0 ? 'empty' : 'populated';
  }

  /**
   * BOUND path (contract §5 · F08). Takes the read-only verdict + writer
   * attribution straight from the slot (the template already surfaces "Values
   * from {writer}" off these two fields), and derives ROWS honestly from the
   * slot's live value — see {@link deriveBoundRows}. `value === undefined`
   * means the slot has not been populated yet (BoundState's own doc'd contract)
   * so that renders `loading`, same affordance as the self-sourced path.
   */
  private recomputeBound(bound: BoundState<unknown>): void {
    this.readonly = bound.readonly;
    this.writer = bound.writer;

    if (bound.value === undefined) {
      this.resolved = 'loading';
      this.rows = [];
      return;
    }

    this.rows = this.deriveBoundRows(bound);
    this.resolved = this.rows.length === 0 ? 'empty' : 'populated';
  }

  /**
   * Derive HONEST key-value rows from a bound slot's live value. Never invents a
   * figure — every row's display text is a literal count, a literal item name,
   * or a literal field echoed straight from the slot:
   *   - `list`   → a "tracked" count row, plus one row per item naming it (by its
   *                own `name` field when present, else its raw string form).
   *                This is the shape the shared `ingredients` list binds to.
   *   - `record` → one row per field, echoing the field's own value verbatim.
   *   - `scalar` → a single row echoing the value verbatim.
   */
  private deriveBoundRows(bound: BoundState<unknown>): KvRow[] {
    const { kind, value } = bound;

    if (kind === 'list') {
      const items = Array.isArray(value) ? value : [];
      if (items.length === 0) return [];
      const rows: KvRow[] = [
        {
          key: '__count',
          label: 'Ingredients tracked',
          display: String(items.length),
          present: true,
          tone: null,
          emphasis: 'strong',
        },
      ];
      items.forEach((item, i) => {
        rows.push({
          key: `__item_${i}`,
          label: `Ingredient ${i + 1}`,
          display: this.itemLabel(item),
          present: true,
          tone: null,
          emphasis: null,
        });
      });
      return rows;
    }

    if (kind === 'record') {
      if (!value || typeof value !== 'object') return [];
      const entries = Object.entries(value as Record<string, unknown>);
      return entries.map(([key, v]) => {
        const present = v !== null && v !== undefined && v !== '';
        return {
          key,
          label: this.humanize(key),
          display: present ? String(v) : '—',
          present,
          tone: null,
          emphasis: null,
        };
      });
    }

    // scalar
    if (value === null || value === undefined || value === '') return [];
    return [
      {
        key: 'value',
        label: this.title ?? 'Value',
        display: String(value),
        present: true,
        tone: null,
        emphasis: null,
      },
    ];
  }

  /** The name to show for one bound list item — never a fabricated figure. */
  private itemLabel(item: unknown): string {
    if (item && typeof item === 'object' && 'name' in (item as Record<string, unknown>)) {
      const name = (item as Record<string, unknown>)['name'];
      if (typeof name === 'string' && name.trim().length > 0) return name;
    }
    if (typeof item === 'string' && item.trim().length > 0) return item;
    return 'Unnamed item';
  }

  /**
   * The empty-state copy: an explicit `states.empty` override wins (contract
   * §6 — copy only); a bound-but-empty slot names ITSELF ("No ingredients yet"
   * for the `ingredients` slot) rather than a generic message, since the panel
   * now knows exactly what's missing; otherwise the widget-type default.
   */
  get emptyMessage(): string {
    if (this.states.empty) return this.states.empty;
    if (this.bound) return `No ${this.bound.slot.replace(/_/g, ' ')} yet`;
    return 'No data';
  }

  /**
   * Explicit `fields` projection when provided; otherwise AUTO-render every value
   * key in declared order (schema: "with no props the panel auto-renders every
   * field of the bound record").
   */
  private effectiveFields(): KvFieldSpec[] {
    if (this.fields && this.fields.length > 0) return this.fields;
    return Object.keys(this.values || {}).map((key) => ({ key }));
  }

  private buildRows(): KvRow[] {
    const out: KvRow[] = [];
    for (const spec of this.effectiveFields()) {
      const tv = this.values ? this.values[spec.key] : undefined;
      const present = tv
        ? tv.present ?? (tv.raw !== null && tv.raw !== undefined && tv.raw !== '')
        : false;

      if (!present && (spec.hide_when_empty || this.onMissing === 'hide')) {
        continue; // row omitted entirely
      }

      out.push({
        key: spec.key,
        label: spec.label ?? this.humanize(spec.key),
        display: present ? tv?.display ?? this.format(tv, spec) : '—', // em-dash TEXT placeholder
        present,
        tone: spec.tone ?? null,
        emphasis: spec.emphasis ?? null,
      });
    }
    return out;
  }

  /** 'protein_g' → 'Protein G' (fallback only; skills usually author `label`). */
  private humanize(key: string): string {
    return key
      .split('_')
      .filter((p) => p.length > 0)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join(' ');
  }

  /** First-party, locale-aware value formatting (schema $defs/valueType). */
  private format(tv: KvTypedValue | undefined, spec: KvFieldSpec): string {
    const type = spec.value_type ?? tv?.type ?? 'text';
    const raw = tv?.raw;
    if (raw === null || raw === undefined) return '—';
    const p = spec.precision;

    switch (type) {
      case 'integer':
        return this.withUnit(Math.round(Number(raw)).toLocaleString(), spec);
      case 'number':
        return this.withUnit(
          Number(raw).toLocaleString(
            undefined,
            p != null ? { minimumFractionDigits: p, maximumFractionDigits: p } : undefined
          ),
          spec
        );
      case 'percent':
        return (Number(raw) * 100).toFixed(p ?? 0) + '%';
      case 'currency':
        try {
          return new Intl.NumberFormat(undefined, {
            style: 'currency',
            currency: spec.currency_code ?? 'USD',
            minimumFractionDigits: p ?? 2,
            maximumFractionDigits: p ?? 2,
          }).format(Number(raw));
        } catch {
          return this.withUnit(Number(raw).toFixed(p ?? 2), spec);
        }
      case 'duration':
        return this.formatDuration(Number(raw));
      case 'bytes':
        return this.formatBytes(Number(raw), p);
      case 'datetime': {
        const d = new Date(String(raw));
        return isNaN(+d) ? String(raw) : d.toLocaleString();
      }
      case 'date': {
        const d = new Date(String(raw));
        return isNaN(+d) ? String(raw) : d.toLocaleDateString();
      }
      case 'time': {
        const d = new Date(String(raw));
        return isNaN(+d) ? String(raw) : d.toLocaleTimeString();
      }
      case 'bool': {
        const b = !!raw;
        return b ? spec.bool_labels?.true ?? 'Yes' : spec.bool_labels?.false ?? 'No';
      }
      case 'enum': {
        const k = String(raw);
        return spec.enum_labels?.[k] ?? k;
      }
      case 'text':
      default:
        return this.withUnit(String(raw), spec);
    }
  }

  private withUnit(s: string, spec: KvFieldSpec): string {
    return spec.unit ? `${s} ${spec.unit}` : s;
  }

  private formatDuration(totalSec: number): string {
    const s = Math.max(0, Math.round(totalSec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const parts: string[] = [];
    if (h) parts.push(`${h} h`);
    if (m) parts.push(`${m} m`);
    if (!h && sec) parts.push(`${sec} s`);
    return parts.length ? parts.join(' ') : '0 s';
  }

  private formatBytes(n: number, p?: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = Math.max(0, n);
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    const digits = p ?? (i === 0 ? 0 : 1);
    return `${v.toFixed(digits)} ${units[i]}`;
  }
}
