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

    this.rows = this.buildRows();
    this.resolved = this.lifecycle === 'empty' || this.rows.length === 0 ? 'empty' : 'populated';
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
