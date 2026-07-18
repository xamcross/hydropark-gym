import { Inject, Injectable, computed, signal } from '@angular/core';
import { IPC_PORT, IpcPort } from '../ipc/ipc.port';
import { SessionService } from '../state/session.service';
import { TelemetryService } from '../state/telemetry.service';
import { SkillId } from '../ipc/contract';
import { HardwareVerdict, estimateHardware } from './hardware-tier';

/** The ordered onboarding steps (SPEC §16.1 first-run flow). */
export type OnboardingStep = 'welcome' | 'hardware' | 'model' | 'tour' | 'email';
export const ONBOARDING_STEPS: readonly OnboardingStep[] = ['welcome', 'hardware', 'model', 'tour', 'email'] as const;

/** The free skill the guided tour enables — the H1 transform surface (SPEC §9.6). */
const FREE_SKILL_ID: SkillId = 'kitchen-timer';

/** localStorage keys. Bumped-suffix so a schema change starts a fresh first-run. */
const SEEN_KEY = 'hydropark.onboarding.completed.v1';
const EMAIL_KEY = 'hydropark.onboarding.email.v1';

/** Honest facts about the bundled on-device model (no downloader yet — it ships in the app). */
export interface BundledModelInfo {
  readonly name: string;
  readonly quant: string;
  readonly approxSizeGb: number;
  readonly ctxTokens: number;
}
// 2026-07-19: swapped 3B -> 7B (same GGUF/quant family) for better tool-chaining
// (ingredient-list population) and prose/arg consistency (duration sanity) — see
// client/docs/REAL-INFERENCE.md. approxSizeGb is the verified on-disk size of the
// downloaded GGUF (4,683,074,240 bytes); ctxTokens matches `HYDROPARK_N_CTX`'s new
// default in inference.rs (8192, bumped from 4096 — verified to load on this
// machine's RAM headroom).
export const BUNDLED_MODEL: BundledModelInfo = {
  name: 'Qwen2.5-7B-Instruct',
  quant: 'Q4_K_M',
  approxSizeGb: 4.68,
  ctxTokens: 8192,
};

export type EmailStatus = 'idle' | 'saved' | 'invalid';

/**
 * ONBOARDING SERVICE (P1-11.4 · SPEC §16.1) — owns the first-run flow's STATE:
 * whether to show it (a resettable localStorage flag), which step is active,
 * step navigation, the honest hardware probe, the guided-tour skill enable
 * (the §9.6 "wow" beat), and the OPTIONAL email capture (never required — matches
 * P1-09.1).
 *
 * `providedIn: 'root'` so the flag is resolved once at bootstrap and the overlay
 * component (and a dev "replay" affordance) share one instance. DOM/storage
 * access is guarded so it degrades cleanly under SSR / private-mode / tests.
 */
@Injectable({ providedIn: 'root' })
export class OnboardingService {
  readonly steps = ONBOARDING_STEPS;
  readonly stepCount = ONBOARDING_STEPS.length;
  readonly model = BUNDLED_MODEL;

  private readonly _active = signal(false);
  /** True while the first-run overlay should be shown over the shell. */
  readonly active = this._active.asReadonly();

  private readonly _index = signal(0);
  readonly step = computed<OnboardingStep>(() => ONBOARDING_STEPS[this._index()]);
  /** 1-based position for the "Step X of N" affordance. */
  readonly stepNumber = computed(() => this._index() + 1);
  readonly isFirst = computed(() => this._index() === 0);
  readonly isLast = computed(() => this._index() === ONBOARDING_STEPS.length - 1);

  // --- hardware probe (honest, read-only covariate) ------------------------
  private readonly _probing = signal(false);
  readonly probing = this._probing.asReadonly();
  private readonly _probeError = signal<string | null>(null);
  readonly probeError = this._probeError.asReadonly();
  /** The rendered hardware verdict, derived from the shared session profile. */
  readonly tier = computed<HardwareVerdict>(() => estimateHardware(this.session.hardwareProfile()));

  // --- guided tour ---------------------------------------------------------
  private readonly _tourBusy = signal(false);
  readonly tourBusy = this._tourBusy.asReadonly();
  private readonly _tourError = signal<string | null>(null);
  readonly tourError = this._tourError.asReadonly();
  /** Mirror of the free skill's enabled state — drives the §9.6 demo beat + the primary CTA. */
  readonly skillEnabled = computed(() => this.session.kitchenSkillEnabled());

  // --- optional email capture (P1-09.1) ------------------------------------
  private readonly _emailCaptured = signal<string | null>(null);
  readonly emailCaptured = this._emailCaptured.asReadonly();
  private readonly _emailStatus = signal<EmailStatus>('idle');
  readonly emailStatus = this._emailStatus.asReadonly();

  constructor(
    @Inject(IPC_PORT) private readonly ipc: IpcPort,
    private readonly session: SessionService,
    private readonly telemetry: TelemetryService
  ) {
    this._emailCaptured.set(this.read(EMAIL_KEY));
    // Auto-show on the very first run only. Later runs (flag present) start hidden;
    // a dev affordance can `restart()` it.
    if (!this.hasSeen()) this.begin();
  }

  // --- lifecycle -----------------------------------------------------------

  /** Open the flow at step one and kick off the hardware probe so step 2 is ready. */
  begin(): void {
    this._index.set(0);
    this._tourError.set(null);
    this._active.set(true);
    void this.probeHardware();
  }

  /** Dev/settings affordance: forget the flag and replay from the top (resettable). */
  restart(): void {
    this.remove(SEEN_KEY);
    this.begin();
  }

  /** Finish: record the flag so it never auto-shows again, then hand off to the shell. */
  complete(): void {
    this.write(SEEN_KEY, '1');
    this._active.set(false);
  }

  /** "Skip for now" / Escape — same durable effect as finishing (the flow is one-time). */
  skip(): void {
    this.complete();
  }

  // --- navigation ----------------------------------------------------------

  next(): void {
    if (this.isLast()) {
      this.complete();
      return;
    }
    this._index.update((i) => Math.min(ONBOARDING_STEPS.length - 1, i + 1));
  }

  back(): void {
    this._index.update((i) => Math.max(0, i - 1));
  }

  goTo(step: OnboardingStep): void {
    const idx = ONBOARDING_STEPS.indexOf(step);
    if (idx >= 0) this._index.set(idx);
  }

  // --- hardware probe ------------------------------------------------------

  /**
   * Populate the shared hardware profile if it isn't already (app.component also
   * probes at boot; this is idempotent and covers the overlay running first).
   */
  async probeHardware(): Promise<void> {
    if (this.session.hardwareProfile() || this._probing()) return;
    this._probing.set(true);
    this._probeError.set(null);
    try {
      const hw = await this.ipc.invoke('get_hardware_profile', undefined);
      this.session.hardwareProfile.set(hw);
    } catch {
      this._probeError.set('Could not read your hardware profile — on-device speed will still be measured live as you chat.');
    } finally {
      this._probing.set(false);
    }
  }

  // --- guided tour (the §9.6 enable transform beat) ------------------------

  /**
   * Enable the FREE skill exactly as the shell's SkillToggle does (IPC enable +
   * session flag + activation telemetry + a system transcript line), so the demo
   * panels animate in AND the handoff to the shell shows a live, enabled skill.
   * Idempotent; tolerant of an IPC rejection (surfaces an honest note, never throws).
   */
  async enableFreeSkill(): Promise<void> {
    if (this.session.kitchenSkillEnabled() || this._tourBusy()) return;
    this._tourBusy.set(true);
    this._tourError.set(null);
    try {
      await this.ipc.invoke('skill_enable', { skill_id: FREE_SKILL_ID });
      this.session.kitchenSkillEnabled.set(true);
      this.telemetry.skillEnabled(FREE_SKILL_ID);
      this.session.addMessage({
        id: crypto.randomUUID(),
        role: 'system',
        text: '— Kitchen Timer & Units enabled: timers, an ingredient list, and unit conversion are now available —',
        streaming: false,
      });
    } catch {
      this._tourError.set('Could not enable the skill just now — you can turn it on from the Assistant view after onboarding.');
    } finally {
      this._tourBusy.set(false);
    }
  }

  // --- optional email capture ----------------------------------------------

  /**
   * Capture an email for later "new skills" updates. NEVER required — an empty or
   * invalid value is a no-op that flags the status; a valid one is stored LOCALLY
   * (no server sign-up exists yet — the P1-09.1 backend handoff reads this value).
   */
  captureEmail(raw: string): boolean {
    const email = raw.trim();
    if (!email) {
      this._emailStatus.set('idle');
      return false;
    }
    if (!isValidEmail(email)) {
      this._emailStatus.set('invalid');
      return false;
    }
    this.write(EMAIL_KEY, email);
    this._emailCaptured.set(email);
    this._emailStatus.set('saved');
    return true;
  }

  clearEmailStatus(): void {
    if (this._emailStatus() !== 'saved') this._emailStatus.set('idle');
  }

  // --- durable flag helpers (guarded) --------------------------------------

  private hasSeen(): boolean {
    return this.read(SEEN_KEY) === '1';
  }

  private read(key: string): string | null {
    try {
      return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    } catch {
      return null;
    }
  }

  private write(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* storage unavailable — the flow still works in-session, it just re-shows next run */
    }
  }

  private remove(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }
}

/** Pragmatic email shape check — enough to avoid obvious typos, never a gate. */
export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}
