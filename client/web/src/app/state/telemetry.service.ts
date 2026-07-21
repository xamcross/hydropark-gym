import { Injectable, Inject, signal } from '@angular/core';
import {
  HardwareProfile,
  ListOp,
  SkillId,
  TELEMETRY_SCHEMA_VERSION,
  TelemetryEvent,
  ToolCallSource,
  UnitSystem,
} from '../ipc/contract';
import { IPC_PORT, IpcPort } from '../ipc/ipc.port';
import { SessionService } from './session.service';

/** localStorage key holding the "an earlier session has already run" marker (for `first_session`). */
const PRIOR_SESSION_KEY = 'hydropark.telemetry.prior-session.v1';

/**
 * The one place the app emits telemetry events (P0-06.1). Every call
 * forwards to `telemetry_log` over the IPC port; Rust owns the actual
 * JSONL file (see IPC-CONTRACT.md — "telemetry sink" is a Rust
 * responsibility, never written directly by the webview).
 *
 * OPT-IN (P1-10.3, SPEC §15/§25): every emission is gated on {@link enabled}.
 * When telemetry is off, `log` is a no-op — nothing crosses the IPC boundary,
 * and no session-metric bookkeeping is consumed. The Rust sink mirrors the
 * same guard as defense-in-depth (telemetry.rs), so this is belt-and-braces.
 *
 * PRODUCT METRICS (P1-25.1): beyond the P0 session events, this service emits
 * the four north-star metrics — activation, composition, offline-usage share,
 * and crash-free session — all anonymized (enums/booleans/counts only, no
 * names and no conversation content).
 *
 * `MockIpcService` additionally buffers events in memory and exposes
 * `downloadLog()` (see mock-ipc.service.ts) so the JSONL schema can be
 * inspected without a real Tauri build — useful for building the P0-06.2
 * scoring sheet before the Rust side compiles anywhere.
 */
@Injectable({ providedIn: 'root' })
export class TelemetryService {
  /**
   * Opt-in consent (P1-10.3). The first-run consent flow / settings toggle
   * drives this via {@link setEnabled}; while it is `false`, {@link log} emits
   * nothing. Defaults to `true` to preserve the prototype's current always-on
   * behavior — the shipping first-run default is P1-10.3's to set.
   */
  private readonly _enabled = signal(true);
  readonly enabled = this._enabled.asReadonly();

  // --- product-metric session bookkeeping (never leaves the device) --------
  /** Whether an `activation` event has already fired this session. */
  private activatedThisSession = false;
  /** Memoized `first_session` verdict (marker consumed at most once). */
  private firstSessionResolved: boolean | null = null;
  /** Count of backend/network-backed IPC calls made this session (offline-usage share). */
  private backendCalls = 0;
  /** Count of unhandled errors/rejections observed this session (crash-free session). */
  private errorCount = 0;
  /** One-shot guard so the session-level metrics are emitted at most once. */
  private sessionEndEmitted = false;

  constructor(@Inject(IPC_PORT) private readonly ipc: IpcPort, private readonly session: SessionService) {
    // Crash-free / session-end signals: observe unhandled failures and the
    // page teardown. These only tally an in-memory count (no message, no
    // stack) and — for teardown — flush the session-level metrics.
    if (typeof window !== 'undefined') {
      window.addEventListener('error', this.onUnhandledError);
      window.addEventListener('unhandledrejection', this.onUnhandledError);
      window.addEventListener('pagehide', this.onPageHide);
    }
  }

  /** Flip the opt-in state (P1-10.3). While `false`, nothing is emitted. */
  setEnabled(on: boolean): void {
    this._enabled.set(on);
  }

  private base() {
    return {
      schema_version: TELEMETRY_SCHEMA_VERSION,
      session_id: this.session.sessionId,
      ts_ms: Date.now(),
    };
  }

  private log(event: TelemetryEvent): void {
    // Opt-in guard (P1-10.3): suppress ALL emission when telemetry is off.
    if (!this._enabled()) return;
    void this.ipc.invoke('telemetry_log', event);
  }

  skillEnabled(skill_id: SkillId): void {
    this.log({ ...this.base(), event: 'skill_enabled', skill_id });
    // PRODUCT METRIC — activation: the first skill enabled this session. Gated
    // on consent so no first-session marker is consumed while telemetry is off
    // (the activation can then still fire in a later, opted-in session).
    if (!this._enabled() || this.activatedThisSession) return;
    this.activatedThisSession = true;
    this.log({ ...this.base(), event: 'activation', skill_id, first_session: this.consumeFirstSession() });
  }

  skillDisabled(skill_id: SkillId): void {
    this.log({ ...this.base(), event: 'skill_disabled', skill_id });
  }

  timerStarted(timer_id: string, label: string, duration_sec: number, source: ToolCallSource): void {
    this.log({ ...this.base(), event: 'timer_started', timer_id, label, duration_sec, source });
  }

  listEdited(op: ListOp, source: ToolCallSource, item_count_after: number): void {
    this.log({ ...this.base(), event: 'list_edited', op, source, item_count_after });
  }

  unitsFlipped(from: UnitSystem, to: UnitSystem, source: ToolCallSource): void {
    this.log({ ...this.base(), event: 'units_flipped', from, to, source });
  }

  tokPerSec(value: number, hardware: HardwareProfile): void {
    this.log({ ...this.base(), event: 'tok_per_sec', value, hardware });
  }

  outcome(name: 'timer_started_unprompted' | 'list_edited_unprompted' | 'session_end', detail?: string): void {
    this.log({ ...this.base(), event: 'outcome', name, detail });
  }

  /** First-run guided tour lifecycle (P1-11.4 tour). `step` is the 1-based step reached. */
  tour(action: 'start' | 'advance' | 'complete' | 'skip', step: number): void {
    this.log({ ...this.base(), event: 'tour', action, step });
  }

  // --- product metrics (P1-25.1) -------------------------------------------

  /**
   * PRODUCT METRIC — composition rate. Call when the live agent becomes
   * composed from 2+ skills, or from an adopted template. `CompositionService`
   * owns the once-per-transition dedupe, so callers may call freely.
   */
  composition(skills_active: number, via_template: boolean): void {
    this.log({ ...this.base(), event: 'composition', skills_active, via_template });
  }

  /**
   * Record one backend/network-backed IPC call (offline-usage share). Called
   * from the real catalog adapter's IPC calls; a session that never calls this
   * reports `offline: true` at session end.
   */
  noteBackendCall(): void {
    this.backendCalls += 1;
  }

  /**
   * Emit the session-level metrics (offline-usage share + crash-free session).
   * Idempotent: fires at most once, whichever of `pagehide` / an explicit
   * end-of-session call reaches it first.
   */
  sessionEnded(): void {
    if (this.sessionEndEmitted) return;
    this.sessionEndEmitted = true;
    this.log({
      ...this.base(),
      event: 'offline_usage',
      offline: this.backendCalls === 0,
      backend_calls: this.backendCalls,
    });
    this.log({
      ...this.base(),
      event: 'crash_free_session',
      crash_free: this.errorCount === 0,
      errors: this.errorCount,
    });
  }

  // --- internals -----------------------------------------------------------

  private readonly onUnhandledError = (): void => {
    // Tally only — never the error's message or stack (§15: no content).
    this.errorCount += 1;
  };

  private readonly onPageHide = (): void => {
    this.sessionEnded();
  };

  /**
   * Resolve (once) whether this is the install's first session, consuming the
   * durable marker so later sessions report `false`. Degrades to `false` when
   * local storage is unavailable — better to under-count first sessions than
   * to claim one we cannot dedupe.
   */
  private consumeFirstSession(): boolean {
    if (this.firstSessionResolved !== null) return this.firstSessionResolved;
    let first = false;
    try {
      if (!window.localStorage.getItem(PRIOR_SESSION_KEY)) {
        window.localStorage.setItem(PRIOR_SESSION_KEY, '1');
        first = true;
      }
    } catch {
      first = false; // storage disabled/full — cannot dedupe, so don't claim "first".
    }
    this.firstSessionResolved = first;
    return first;
  }
}
