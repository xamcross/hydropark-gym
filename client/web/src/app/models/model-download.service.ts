import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { IPC_PORT } from '../ipc/ipc.port';
import { ModelDownloadStatus } from '../ipc/contract';

/**
 * MODEL-DOWNLOAD SERVICE (P1-02.7) — the webview half of the on-demand,
 * RESUMABLE model downloader. The Rust core owns the actual HTTP range-download,
 * the on-disk temp file, the resume offset, and the SHA-256 verify; this service
 * only:
 *   - starts / resumes / cancels a download (via the `model_download_*` commands),
 *   - reflects the REAL byte counts the core streams on `model://progress`, and
 *   - derives a smoothed transfer RATE from successive byte deltas (never a
 *     fabricated figure — if the core stops sending bytes, the rate stops moving).
 *
 * `providedIn: 'root'` so a download survives navigation / component remounts:
 * the live status lives here, and any `<app-model-download>` bound to the same
 * `modelId` re-renders it. NO fake progress ever originates here — the fraction a
 * bar shows is `bytes / totalBytes`, and only when `totalBytes` is known.
 */
@Injectable({ providedIn: 'root' })
export class ModelDownloadService {
  private readonly ipc = inject(IPC_PORT);

  /** modelId → latest real status snapshot (from start/status/progress). */
  private readonly _statuses = signal<Record<string, ModelDownloadStatus>>({});
  readonly statuses = this._statuses.asReadonly();

  /** modelId → smoothed bytes/sec, derived from REAL byte deltas between events. */
  private readonly _rates = signal<Record<string, number>>({});
  /** Last sample used to compute an instantaneous rate. */
  private readonly rateSamples = new Map<string, { bytes: number; t: number }>();

  /** True when ANY tracked model is queued/downloading/verifying. */
  readonly anyActive = computed(() =>
    Object.values(this._statuses()).some((s) => isTransferPhase(s.phase))
  );

  constructor() {
    const unlisten = this.ipc.on('model://progress', (s) => this.ingest(s));
    inject(DestroyRef).onDestroy(unlisten);
  }

  // --- reads ---------------------------------------------------------------

  statusFor(modelId: string): ModelDownloadStatus | null {
    return this._statuses()[modelId] ?? null;
  }

  /** Smoothed transfer rate in bytes/sec, or null when not actively transferring. */
  rateFor(modelId: string): number | null {
    const s = this._statuses()[modelId];
    if (!s || s.phase !== 'downloading') return null;
    return this._rates()[modelId] ?? null;
  }

  // --- intents -------------------------------------------------------------

  /**
   * Begin (or resume) a download. `resume` defaults to true so a retained partial
   * is picked up; pass `false` to force a clean restart. Tolerant of an IPC
   * rejection — it surfaces as an `error` snapshot the UI can retry, never throws.
   */
  async start(modelId: string, opts?: { resume?: boolean }): Promise<void> {
    this.rateSamples.delete(modelId);
    this._rates.update((m) => dropKey(m, modelId));
    try {
      const snap = await this.ipc.invoke('model_download_start', {
        modelId,
        resume: opts?.resume ?? true,
      });
      this.ingest(snap);
    } catch (e) {
      const prev = this.statusFor(modelId);
      this.setStatus({
        modelId,
        phase: 'error',
        bytes: prev?.bytes ?? 0,
        totalBytes: prev?.totalBytes ?? null,
        resumed: false,
        message: errText(e),
      });
    }
  }

  /** Cancel an in-flight download. The core may retain a resumable partial. */
  async cancel(modelId: string): Promise<void> {
    try {
      await this.ipc.invoke('model_download_cancel', { modelId });
    } catch {
      // Best-effort — a `cancelled`/`error` progress event still settles the UI.
    }
  }

  /** Reconcile with the core (e.g. on mount) — picks up an in-flight or partial download. */
  async refresh(modelId: string): Promise<void> {
    try {
      const snap = await this.ipc.invoke('model_download_status', { modelId });
      if (snap) this.ingest(snap);
    } catch {
      // Non-fatal — leave the last-known status in place.
    }
  }

  // --- internals -----------------------------------------------------------

  private ingest(s: ModelDownloadStatus): void {
    this.updateRate(s);
    this.setStatus(s);
  }

  /** Derive a smoothed rate from the delta between this event and the last one. */
  private updateRate(s: ModelDownloadStatus): void {
    if (s.phase !== 'downloading') {
      this.rateSamples.delete(s.modelId);
      return;
    }
    const now = performance.now();
    const prev = this.rateSamples.get(s.modelId);
    this.rateSamples.set(s.modelId, { bytes: s.bytes, t: now });
    if (!prev) return;
    const dt = (now - prev.t) / 1000;
    const db = s.bytes - prev.bytes;
    if (dt <= 0 || db < 0) return;
    const inst = db / dt;
    this._rates.update((m) => {
      const prevRate = m[s.modelId];
      const ema = prevRate == null ? inst : prevRate * 0.6 + inst * 0.4;
      return { ...m, [s.modelId]: ema };
    });
  }

  private setStatus(s: ModelDownloadStatus): void {
    this._statuses.update((m) => ({ ...m, [s.modelId]: s }));
  }
}

/** The phases during which bytes are (or are about to be) moving. */
export function isTransferPhase(phase: ModelDownloadStatus['phase']): boolean {
  return phase === 'queued' || phase === 'downloading' || phase === 'verifying';
}

function dropKey<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : 'The download could not be started.';
}

// ---------------------------------------------------------------------------
// Downloadable-model registry (webview side) — the optional larger models the
// on-demand downloader can pull. Mirrors the core-side registry keyed by `id`.
// ---------------------------------------------------------------------------

export interface DownloadableModel {
  readonly id: string;
  readonly name: string;
  readonly quant: string;
  /** Approximate on-disk size in bytes (the real total arrives via `model://progress`). */
  readonly sizeBytes: number;
  readonly ctxTokens: number;
  /** One honest sentence on what you gain vs. the bundled model. */
  readonly blurb: string;
}

export const DOWNLOADABLE_MODELS: readonly DownloadableModel[] = [
  {
    id: 'qwen2.5-7b-instruct-q4km',
    name: 'Qwen2.5-7B-Instruct',
    quant: 'Q4_K_M',
    sizeBytes: 4_680_000_000,
    ctxTokens: 8192,
    blurb: 'A larger model — noticeably stronger reasoning, at a slower per-token pace.',
  },
] as const;

/** The single optional model surfaced in onboarding step 3 (the bundled one keeps working). */
export const LARGER_MODEL: DownloadableModel = DOWNLOADABLE_MODELS[0];
