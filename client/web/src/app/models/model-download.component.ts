import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  untracked,
} from '@angular/core';
import { ModelDownloadService, isTransferPhase } from './model-download.service';
import { ModelDownloadPhase } from '../ipc/contract';

/** The presentational phase this component renders — the contract phases plus a synthetic 'idle'. */
type ViewPhase = ModelDownloadPhase | 'idle';

/**
 * MODEL-DOWNLOAD SURFACE (P1-02.7) — a self-contained, reusable download control
 * for one model. Bind it to a `modelId` (plus a display `modelName` / `sizeBytes`)
 * and it renders the live state the {@link ModelDownloadService} holds:
 *
 *   idle      → a "Download" affordance with the expected size
 *   queued /  → a REAL-progress bar (determinate when the total is known,
 *   downloading  indeterminate before headers land) + a byte / rate / ETA readout
 *               + Cancel
 *   verifying → an indeterminate "Checking integrity…" bar
 *   complete  → a verified, on-disk confirmation (icon + text)
 *   paused /  → a resumable state that keeps the retained partial + Resume
 *   cancelled
 *   error     → the failure message + Resume / Try again
 *
 * Honesty (P1-02.7): the bar's fill is ONLY ever `bytes / totalBytes` from the
 * event — there is no synthetic animation. When the total is unknown the bar is
 * indeterminate rather than showing a made-up percentage.
 *
 * Accessibility: the bar is a real `role="progressbar"` with aria-value* /
 * aria-valuetext; magnitude is carried by fill extent AND text, never colour
 * alone (WCAG 1.4.1). The fast byte readout is NOT a live region (it would spam a
 * screen reader) — a separate, 10%-bucketed polite `status` region announces
 * milestones and phase changes.
 *
 * OnPush + signals throughout; token-only styling.
 */
@Component({
  selector: 'app-model-download',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './model-download.component.html',
  styleUrl: './model-download.component.css',
})
export class ModelDownloadComponent {
  private readonly svc = inject(ModelDownloadService);

  readonly modelId = input.required<string>();
  readonly modelName = input('');
  /** Expected on-disk size in bytes, for the idle affordance (the real total streams later). */
  readonly sizeBytes = input<number | null>(null);

  // --- live state ----------------------------------------------------------

  readonly status = computed(() => this.svc.statusFor(this.modelId()));
  readonly phase = computed<ViewPhase>(() => this.status()?.phase ?? 'idle');
  readonly isTransferring = computed(() => {
    const p = this.status()?.phase;
    return p != null && isTransferPhase(p);
  });
  /** True in paused/cancelled/error states that retain a partial to resume from. */
  readonly resumable = computed(() => {
    const s = this.status();
    if (!s) return false;
    return (s.phase === 'paused' || s.phase === 'cancelled' || s.phase === 'error') && s.bytes > 0;
  });

  /** [0,1] fraction of the transfer, or null when the total isn't known yet (⇒ indeterminate). */
  readonly fraction = computed<number | null>(() => {
    const s = this.status();
    if (!s || !s.totalBytes || s.totalBytes <= 0) return null;
    return Math.min(1, s.bytes / s.totalBytes);
  });
  /** Determinate only while downloading with a known total; everything else is indeterminate. */
  readonly determinate = computed(() => this.phase() === 'downloading' && this.fraction() !== null);
  /** Integer percent for the bar fill + aria-valuetext (0 when indeterminate). */
  readonly percent = computed(() => {
    const f = this.fraction();
    return f === null ? 0 : Math.round(f * 100);
  });

  // --- readouts (all REAL figures) -----------------------------------------

  readonly displayName = computed(() => this.modelName() || this.modelId());

  /** e.g. "1.24 GB of 4.68 GB" (or just "1.24 GB" before the total is known). */
  readonly bytesText = computed(() => {
    const s = this.status();
    if (!s) return '';
    const done = formatBytes(s.bytes);
    return s.totalBytes ? `${done} of ${formatBytes(s.totalBytes)}` : done;
  });

  readonly rateText = computed(() => {
    const r = this.svc.rateFor(this.modelId());
    return r && r > 0 ? `${formatBytes(r)}/s` : '';
  });

  readonly etaText = computed(() => {
    const s = this.status();
    const r = this.svc.rateFor(this.modelId());
    if (!s || !s.totalBytes || !r || r <= 0) return '';
    const remaining = s.totalBytes - s.bytes;
    if (remaining <= 0) return '';
    return `${formatDuration(remaining / r)} left`;
  });

  readonly sizeText = computed(() => {
    const n = this.sizeBytes();
    return n && n > 0 ? formatBytes(n) : '';
  });

  /** Partial retained on the disk, shown on the resumable states. */
  readonly retainedText = computed(() => {
    const s = this.status();
    return s && s.bytes > 0 ? formatBytes(s.bytes) : '';
  });

  readonly errorMessage = computed(() => this.status()?.message || 'The download stopped unexpectedly.');

  readonly downloadLabel = computed(() => (this.sizeText() ? `Download (${this.sizeText()})` : 'Download'));

  readonly pausedLine = computed(() => {
    const base = this.phase() === 'cancelled' ? 'Download cancelled' : 'Download paused';
    const kept = this.retainedText();
    return kept ? `${base} — ${kept} kept on disk.` : `${base}.`;
  });

  /** Generic idle description (this control is model-agnostic; the host frames the context). */
  readonly idleLine = 'Download this model to run it on device. It transfers in the background and resumes if interrupted.';

  /** Accessible name for the progress bar. */
  readonly barLabel = computed(() =>
    this.phase() === 'verifying' ? `Verifying ${this.displayName()}` : `Downloading ${this.displayName()}`
  );
  /** aria-valuetext / visible-when-indeterminate label. */
  readonly barValueText = computed(() => {
    if (this.phase() === 'verifying') return 'Verifying…';
    if (this.determinate()) return `${this.percent()}%`;
    return 'Starting…';
  });

  /**
   * Milestone announcement — 10% buckets + phase transitions only, so a screen
   * reader hears "…40 percent … 50 percent … verifying … downloaded" rather than
   * a byte count every frame. The text only CHANGES on a bucket/phase change, so
   * the polite live region fires just at those moments.
   */
  readonly announce = computed(() => {
    const s = this.status();
    if (!s) return '';
    const name = this.displayName();
    switch (s.phase) {
      case 'downloading': {
        const f = this.fraction();
        if (f === null) return `Downloading ${name}`;
        return `Downloading ${name}, ${Math.round(f * 10) * 10} percent`;
      }
      case 'queued':
        return `Preparing to download ${name}`;
      case 'verifying':
        return `Verifying ${name}`;
      case 'complete':
        return `${name} downloaded and verified`;
      case 'paused':
        return `Download of ${name} paused`;
      case 'cancelled':
        return `Download of ${name} cancelled`;
      case 'error':
        return `Download of ${name} failed`;
    }
  });

  // --- status chip (icon + label + tone — never hue alone) -----------------

  readonly chipLabel = computed<string>(() => {
    switch (this.phase()) {
      case 'downloading':
      case 'queued':
        return 'Downloading';
      case 'verifying':
        return 'Verifying';
      case 'complete':
        return 'Downloaded';
      case 'paused':
        return 'Paused';
      case 'cancelled':
        return 'Cancelled';
      case 'error':
        return 'Failed';
      default:
        return 'Optional';
    }
  });
  readonly chipIcon = computed<string>(() => {
    switch (this.phase()) {
      case 'complete':
        return '✓';
      case 'error':
        return '!';
      case 'paused':
      case 'cancelled':
        return '⏸';
      default:
        return '↓';
    }
  });
  readonly chipTone = computed<'fine' | 'careful'>(() => (this.phase() === 'complete' ? 'fine' : 'careful'));

  constructor() {
    // Reconcile with the core once per bound model, so an in-flight or partial
    // download re-hydrates when this surface (re)mounts.
    effect(() => {
      const id = this.modelId();
      untracked(() => void this.svc.refresh(id));
    });
  }

  // --- actions -------------------------------------------------------------

  download(): void {
    void this.svc.start(this.modelId());
  }

  /** Resume from the retained partial (paused / cancelled / error). */
  resume(): void {
    void this.svc.start(this.modelId(), { resume: true });
  }

  /** Force a clean restart from byte 0 (e.g. re-download after completing). */
  redownload(): void {
    void this.svc.start(this.modelId(), { resume: false });
  }

  cancel(): void {
    void this.svc.cancel(this.modelId());
  }
}

/** SI (base-1000) byte formatter — matches how download sizes are conventionally shown. */
function formatBytes(n: number): string {
  if (!isFinite(n) || n < 0) return '0 B';
  if (n < 1000) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1000;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i += 1;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(v >= 10 ? 1 : 2)} ${units[i]}`;
}

/** Compact human duration, e.g. "2m 05s" or "45s". */
function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${String(rem).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}
