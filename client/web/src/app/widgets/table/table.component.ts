import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  Output,
  computed,
  effect,
  signal,
} from '@angular/core';

/**
 * `table` widget (SPEC 9.4 · schema contracts/widgets/table.schema.json).
 *
 * Typed COLUMNS + ROWS with a CELL TYPE per column, an optional per-column
 * SORT (emits `sort_changed`), and the mandatory loading / empty / error
 * states (base contract §6). Renders READ-ONLY: no inline editing is offered,
 * so when the bound slot is not this skill's to write we only surface the
 * "Managed by {writer}" description (base contract §5) — there are no edit
 * affordances to disable.
 *
 * A11y (base contract §8, enforced per theme in both light/dark):
 *  - a real <table> with <caption>, <th scope="col"> headers and an optional
 *    <th scope="row"> leading column;
 *  - keyboard-operable sort headers (native <button> inside the <th>) that
 *    cycle asc -> desc -> none and drive `aria-sort` (ascending/descending/none);
 *  - sort direction is signalled by an ARROW GLYPH, never colour alone (WCAG 1.4.1);
 *  - `status` cells pair a token tone with a per-tone icon + label; `bool` cells
 *    pair a check/dash glyph with a Yes/No label — never hue-only;
 *  - a polite live region announces out-of-band row updates.
 *
 * Styling is token-only (base contract §7): every colour / space / type / radius
 * value resolves through the design-token vocabulary; no raw hex, hairline
 * borders follow the timer-stack precedent.
 */

export type TableCellType =
  | 'text'
  | 'number'
  | 'integer'
  | 'bool'
  | 'enum'
  | 'date'
  | 'datetime'
  | 'time'
  | 'duration'
  | 'currency'
  | 'percent'
  | 'status';

/** Closed style-variant vocabulary reused from the base contract (§7). */
export type StyleTone = 'default' | 'neutral' | 'accent' | 'positive' | 'caution' | 'danger';
export type StyleAlign = 'start' | 'center' | 'end';
export type ColumnWidth = 'auto' | 'flex' | 'min';

/** Locale-aware DATA-formatting hints (schema $defs/columnFormat) — not styling. */
export interface TableColumnFormat {
  precision?: number;
  grouping?: boolean;
  currencyCode?: string;
  unitLabel?: string;
  dateStyle?: 'short' | 'medium' | 'long' | 'full';
  timeStyle?: 'short' | 'medium' | 'long';
  durationStyle?: 'clock' | 'words' | 'compact';
  trueLabel?: string;
  falseLabel?: string;
  nullText?: string;
}

/** One typed column (schema $defs/columnDef). */
export interface TableColumn {
  key: string;
  header?: string;
  type?: TableCellType;
  align?: StyleAlign;
  width?: ColumnWidth;
  sortable?: boolean;
  truncate?: boolean;
  values?: string[];
  labels?: Record<string, string>;
  toneMap?: Record<string, StyleTone>;
  format?: TableColumnFormat;
}

/** A cell holds a scalar; the row is a record keyed by column.key. */
export type TableCellValue = string | number | boolean | null | undefined;
export type TableRow = Record<string, TableCellValue>;

export type SortDirection = 'asc' | 'desc';
export interface TableSort {
  column: string;
  direction: SortDirection;
}

/** The container lifecycle input (base contract §6). `empty` is derived from ready + zero rows. */
export type TableState = 'loading' | 'ready' | 'error';

/** Internal: a column with every default resolved. */
interface NormalizedColumn {
  key: string;
  header: string;
  type: TableCellType;
  align: StyleAlign;
  width: ColumnWidth;
  truncate: boolean;
  sortableOverride?: boolean;
  values?: string[];
  labels?: Record<string, string>;
  toneMap?: Record<string, StyleTone>;
  format?: TableColumnFormat;
}

/** Internal: a fully-rendered cell projection consumed by the template. */
interface CellView {
  kind: 'status' | 'bool' | 'text';
  text: string;
  icon?: string;
  tone?: StyleTone;
  title: string | null;
  align: StyleAlign;
  width: ColumnWidth;
  isRowHeader: boolean;
}

interface RowView {
  id: string;
  cells: CellView[];
}

let uidCounter = 0;

@Component({
  selector: 'app-table',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './table.component.html',
  styleUrl: './table.component.css',
})
export class TableComponent {
  /** Unique per instance so ids/aria references never collide across tables. */
  readonly uid = ++uidCounter;

  // --- signal-backed inputs (reactive data) --------------------------------

  private readonly _columns = signal<TableColumn[]>([]);
  private readonly _rows = signal<TableRow[]>([]);
  private readonly _sort = signal<TableSort | null>(null);
  private readonly _state = signal<TableState>('ready');

  @Input()
  set columns(value: TableColumn[]) {
    this._columns.set(value ?? []);
  }
  get columns(): TableColumn[] {
    return this._columns();
  }

  @Input()
  set rows(value: TableRow[] | null | undefined) {
    this._rows.set(value ?? []);
  }
  get rows(): TableRow[] {
    return this._rows();
  }

  /** Controlled active sort. Two-way-friendly: internal toggles also write it. */
  @Input()
  set sort(value: TableSort | null | undefined) {
    this._sort.set(value ?? null);
  }
  get sort(): TableSort | null {
    return this._sort();
  }

  /** Initial sort applied once (schema props.default_sort). */
  @Input()
  set defaultSort(value: TableSort | null | undefined) {
    if (value && this._sort() === null) this._sort.set(value);
  }

  @Input()
  set state(value: TableState) {
    this._state.set(value ?? 'ready');
  }
  get state(): TableState {
    return this._state();
  }

  // --- plain config inputs -------------------------------------------------

  /** Master sort switch (schema props.sortable). */
  @Input() sortable = true;
  /** Row-record field used as stable identity (schema props.row_key). */
  @Input() rowKey = 'id';
  /** Render the first column as a <th scope="row"> row header. */
  @Input() rowHeader = true;
  /** Compact vs comfortable density (style variant). */
  @Input() density: 'comfortable' | 'compact' = 'comfortable';

  /** Visible panel heading (widget title). */
  @Input() heading?: string;
  /** Native <caption> text (schema props.caption). */
  @Input() caption?: string;
  /** Accessible name for the <table> (a11y.label / title fallback). */
  @Input() label?: string;

  /** Read-only resolution from the merge layer (base contract §5). */
  @Input() readonly = false;
  @Input() writer?: string;

  // Overridable state copy (base contract §6 — copy only).
  @Input() loadingLabel = 'Loading table…';
  @Input() emptyLabel = 'No rows';
  @Input() errorLabel = "Couldn't load the table.";
  @Input() errorHint = 'Try again.';

  // --- outputs (schema emits — all UI-local, to_chat:false by default) ------

  /** `sort_changed`: null when sort is cleared. */
  @Output() sortChange = new EventEmitter<TableSort | null>();
  /** Recovery affordance for the error state. */
  @Output() retry = new EventEmitter<void>();

  /** Polite announcement for out-of-band row updates. */
  readonly announce = signal('');

  constructor() {
    let first = true;
    effect(() => {
      const n = this._rows().length;
      if (first) {
        first = false;
        return;
      }
      this.announce.set(`Table updated, ${n} ${n === 1 ? 'row' : 'rows'}`);
    });
  }

  // --- derived view model --------------------------------------------------

  readonly displayColumns = computed<NormalizedColumn[]>(() =>
    this._columns().map((c) => this.normalizeColumn(c))
  );

  readonly phase = computed<'loading' | 'empty' | 'error' | 'populated'>(() => {
    const s = this._state();
    if (s === 'loading') return 'loading';
    if (s === 'error') return 'error';
    return this._rows().length === 0 ? 'empty' : 'populated';
  });

  private readonly sortedRows = computed<TableRow[]>(() => {
    const rows = this._rows();
    const sort = this._sort();
    if (!sort) return rows;
    const col = this.displayColumns().find((c) => c.key === sort.column);
    if (!col) return rows;
    const dir = sort.direction === 'desc' ? -1 : 1;
    return rows
      .map((row, index) => ({ row, index }))
      .sort((a, b) => {
        const cmp = this.compare(a.row, b.row, col) * dir;
        return cmp !== 0 ? cmp : a.index - b.index; // stable on original order
      })
      .map((entry) => entry.row);
  });

  readonly viewRows = computed<RowView[]>(() => {
    const cols = this.displayColumns();
    const rowKey = this.rowKey;
    return this.sortedRows().map((row, idx) => {
      const idVal = row[rowKey];
      const id = idVal === undefined || idVal === null ? `row-${idx}` : String(idVal);
      return { id, cells: cols.map((col, ci) => this.buildCell(row, col, ci)) };
    });
  });

  // --- sort interaction ----------------------------------------------------

  isSortable(col: NormalizedColumn): boolean {
    if (!this.sortable) return false;
    return col.sortableOverride ?? this.defaultSortable(col.type);
  }

  ariaSort(col: NormalizedColumn): 'ascending' | 'descending' | 'none' {
    const s = this._sort();
    if (!s || s.column !== col.key) return 'none';
    return s.direction === 'asc' ? 'ascending' : 'descending';
  }

  /** Non-hue sort indicator: an arrow glyph (▲/▼) or an idle up/down glyph. */
  sortGlyph(col: NormalizedColumn): string {
    const s = this._sort();
    if (s && s.column === col.key) return s.direction === 'asc' ? '▲' : '▼';
    return '↕';
  }

  toggleSort(col: NormalizedColumn): void {
    if (this.isSortable(col) === false) return;
    const cur = this._sort();
    let next: TableSort | null;
    if (!cur || cur.column !== col.key) next = { column: col.key, direction: 'asc' };
    else if (cur.direction === 'asc') next = { column: col.key, direction: 'desc' };
    else next = null; // third activation clears the sort
    this._sort.set(next);
    this.sortChange.emit(next);
  }

  // --- normalization / formatting ------------------------------------------

  private normalizeColumn(col: TableColumn): NormalizedColumn {
    const type: TableCellType = col.type ?? 'text';
    return {
      key: col.key,
      header: col.header ?? this.humanize(col.key),
      type,
      align: col.align ?? this.defaultAlign(type),
      width: col.width ?? 'auto',
      truncate: col.truncate ?? this.defaultTruncate(type),
      sortableOverride: col.sortable,
      values: col.values,
      labels: col.labels,
      toneMap: col.toneMap,
      format: col.format,
    };
  }

  private buildCell(row: TableRow, col: NormalizedColumn, ci: number): CellView {
    const value = row[col.key];
    const isRowHeader = this.rowHeader && ci === 0;

    if (col.type === 'status') {
      const key = value === null || value === undefined ? '' : String(value);
      const tone: StyleTone = col.toneMap?.[key] ?? 'neutral';
      const label = col.labels?.[key] ?? (key || (col.format?.nullText ?? '—'));
      return {
        kind: 'status',
        tone,
        icon: this.toneIcon(tone),
        text: label,
        title: null,
        align: col.align,
        width: col.width,
        isRowHeader,
      };
    }

    if (col.type === 'bool') {
      const truthy = value === true || value === 'true' || value === 1;
      const label = truthy ? col.format?.trueLabel ?? 'Yes' : col.format?.falseLabel ?? 'No';
      return {
        kind: 'bool',
        icon: truthy ? '✓' : '–',
        text: label,
        title: null,
        align: col.align,
        width: col.width,
        isRowHeader,
      };
    }

    const text = this.formatCell(col, value);
    return {
      kind: 'text',
      text,
      title: col.truncate ? text : null,
      align: col.align,
      width: col.width,
      isRowHeader,
    };
  }

  private formatCell(col: NormalizedColumn, value: TableCellValue): string {
    if (value === null || value === undefined || value === '') {
      return col.format?.nullText ?? '—';
    }
    try {
      switch (col.type) {
        case 'number':
        case 'integer':
          return this.formatNumber(Number(value), col);
        case 'currency':
          return this.formatCurrency(Number(value), col);
        case 'percent':
          return this.formatPercent(Number(value), col);
        case 'duration':
          return this.formatDuration(Number(value), col.format?.durationStyle ?? 'clock');
        case 'date':
        case 'datetime':
        case 'time':
          return this.formatDateTime(value, col);
        case 'enum':
          return col.labels?.[String(value)] ?? String(value);
        default:
          return String(value);
      }
    } catch {
      return String(value);
    }
  }

  private formatNumber(value: number, col: NormalizedColumn): string {
    const opts: Intl.NumberFormatOptions = {};
    if (col.type === 'integer') opts.maximumFractionDigits = 0;
    const p = col.format?.precision;
    if (p !== undefined) {
      opts.minimumFractionDigits = p;
      opts.maximumFractionDigits = p;
    }
    const grouping = col.format?.grouping;
    if (grouping !== undefined) opts.useGrouping = grouping;
    let out = new Intl.NumberFormat(undefined, opts).format(value);
    const unit = col.format?.unitLabel;
    if (unit) out += ` ${unit}`;
    return out;
  }

  private formatCurrency(value: number, col: NormalizedColumn): string {
    const opts: Intl.NumberFormatOptions = {
      style: 'currency',
      currency: col.format?.currencyCode ?? 'USD',
    };
    const p = col.format?.precision;
    if (p !== undefined) {
      opts.minimumFractionDigits = p;
      opts.maximumFractionDigits = p;
    }
    return new Intl.NumberFormat(undefined, opts).format(value);
  }

  private formatPercent(value: number, col: NormalizedColumn): string {
    // The stored number is the percentage itself (42 -> "42%"), not a fraction.
    const p = col.format?.precision ?? 0;
    const num = new Intl.NumberFormat(undefined, {
      minimumFractionDigits: p,
      maximumFractionDigits: p,
    }).format(value);
    return `${num}%`;
  }

  private formatDateTime(value: TableCellValue, col: NormalizedColumn): string {
    const d = this.toDate(value);
    if (!d) return String(value);
    const opts: Intl.DateTimeFormatOptions = {};
    if (col.type === 'date' || col.type === 'datetime') {
      opts.dateStyle = col.format?.dateStyle ?? 'medium';
    }
    if (col.type === 'time' || col.type === 'datetime') {
      opts.timeStyle = col.format?.timeStyle ?? 'short';
    }
    return new Intl.DateTimeFormat(undefined, opts).format(d);
  }

  private formatDuration(totalSeconds: number, style: 'clock' | 'words' | 'compact'): string {
    const total = Math.max(0, Math.floor(totalSeconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (style === 'words') {
      const parts: string[] = [];
      if (h) parts.push(`${h} h`);
      if (m) parts.push(`${m} min`);
      if (s || parts.length === 0) parts.push(`${s} s`);
      return parts.join(' ');
    }
    if (style === 'compact') {
      if (h) return `${h}h`;
      if (m) return `${m}m`;
      return `${s}s`;
    }
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  private toDate(value: TableCellValue): Date | null {
    if (value === null || value === undefined || typeof value === 'boolean') return null;
    const d = typeof value === 'number' ? new Date(value) : new Date(String(value));
    return isNaN(d.getTime()) ? null : d;
  }

  private compare(a: TableRow, b: TableRow, col: NormalizedColumn): number {
    const av = a[col.key];
    const bv = b[col.key];
    const aEmpty = av === null || av === undefined || av === '';
    const bEmpty = bv === null || bv === undefined || bv === '';
    if (aEmpty && bEmpty) return 0;
    if (aEmpty) return 1; // empties sort last
    if (bEmpty) return -1;

    switch (col.type) {
      case 'number':
      case 'integer':
      case 'currency':
      case 'percent':
      case 'duration':
        return Number(av) - Number(bv);
      case 'bool':
        return (av === true ? 1 : 0) - (bv === true ? 1 : 0);
      case 'date':
      case 'datetime':
      case 'time': {
        const da = this.toDate(av)?.getTime() ?? 0;
        const db = this.toDate(bv)?.getTime() ?? 0;
        return da - db;
      }
      case 'enum':
      case 'status':
        if (col.values && col.values.length) {
          return col.values.indexOf(String(av)) - col.values.indexOf(String(bv));
        }
        return String(av).localeCompare(String(bv));
      default:
        return String(av).localeCompare(String(bv));
    }
  }

  private defaultAlign(type: TableCellType): StyleAlign {
    if (
      type === 'number' ||
      type === 'integer' ||
      type === 'currency' ||
      type === 'percent' ||
      type === 'duration'
    ) {
      return 'end';
    }
    if (type === 'bool') return 'center';
    return 'start';
  }

  private defaultTruncate(type: TableCellType): boolean {
    return type === 'text' || type === 'enum' || type === 'status';
  }

  private defaultSortable(type: TableCellType): boolean {
    return type !== 'bool' && type !== 'status';
  }

  private toneIcon(tone: StyleTone): string {
    switch (tone) {
      case 'positive':
        return '✓';
      case 'caution':
        return '!';
      case 'danger':
        return '✕';
      case 'accent':
        return '◆';
      case 'neutral':
        return '•';
      default:
        return '–';
    }
  }

  private humanize(key: string): string {
    const s = key.replace(/_/g, ' ').trim();
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
}
