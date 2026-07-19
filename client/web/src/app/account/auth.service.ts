import { Injectable, Signal, computed, inject, signal } from '@angular/core';
import { IPC_PORT } from '../ipc/ipc.port';
import { AuthState, StepUpChallenge } from '../ipc/contract';

/** Why the auth prompt was opened — tunes the dialog's framing copy. */
export type AuthPromptReason = 'account' | 'purchase';

/**
 * Client-side identity state and the ONE seam the rest of the app reads/mutates
 * it through (P1-09.1/.2). Mirrors {@link UnlockService}'s shape: signals for
 * state, a thin IPC bridge, and a prompt the rest of the app can raise.
 *
 * EMAIL-OPTIONAL (SPEC §12/§13): the app is fully usable while `anonymous`. An
 * account is only PROMPTED (via the topbar affordance) and only REQUIRED to buy
 * — {@link ensureForPurchase} raises the prompt and resolves once a usable
 * identity (device OR account) exists, or `false` if the user dismisses it.
 *
 * Under a real Tauri shell the Rust core owns the tokens/secure storage; here we
 * only hold the client-visible {@link AuthState} the commands return. Under
 * `ng serve` the mock IPC simulates the whole flow so it is demonstrable with no
 * backend (see mock-ipc.service.ts).
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly ipc = inject(IPC_PORT);

  private readonly _state = signal<AuthState>({ status: 'anonymous' });
  readonly state: Signal<AuthState> = this._state.asReadonly();

  readonly status = computed(() => this._state().status);
  readonly email = computed(() => this._state().email ?? null);
  readonly deviceId = computed(() => this._state().deviceId ?? null);
  /** A full email/password account (portable across installs). */
  readonly isAuthenticated = computed(() => this._state().status === 'authenticated');
  /** Any usable identity — device OR account. This is what buying requires. */
  readonly hasIdentity = computed(() => this._state().status !== 'anonymous');
  /** A pending step-up challenge to render + answer, if any. */
  readonly stepUp = computed<StepUpChallenge | null>(() => this._state().stepUp ?? null);

  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  // --- prompt (the login/register dialog) visibility -----------------------
  private readonly _promptOpen = signal(false);
  readonly promptOpen = this._promptOpen.asReadonly();
  private readonly _promptReason = signal<AuthPromptReason>('account');
  readonly promptReason = this._promptReason.asReadonly();

  /** Resolver for an in-flight {@link ensureForPurchase} await, if any. */
  private pendingGate: ((ready: boolean) => void) | null = null;

  constructor() {
    // Best-effort hydrate. Under the mock this returns `anonymous`; under Tauri
    // it reflects any device/account identity the Rust core already holds.
    void this.refreshStatus();
  }

  /** The access token for authed backend calls (order/entitlement/license/download). */
  bearer(): string | undefined {
    return this._state().accessToken ?? undefined;
  }

  // --- commands ------------------------------------------------------------

  async refreshStatus(): Promise<void> {
    try {
      this.apply(await this.ipc.invoke('auth_status', { bearer: this.bearer() }));
    } catch {
      // Not registered / offline — leave whatever we have (default anonymous).
    }
  }

  /** No-email path: mint (or return) a device-scoped identity that can buy. */
  async ensureDevice(): Promise<boolean> {
    return this.run(() => this.ipc.invoke('device_ensure', {}));
  }

  async register(email: string, password: string): Promise<boolean> {
    return this.run(() => this.ipc.invoke('auth_register', { email, password }));
  }

  async login(email: string, password: string): Promise<boolean> {
    return this.run(() => this.ipc.invoke('auth_login', { email, password }));
  }

  async answerStepUp(answer: string): Promise<boolean> {
    const ch = this.stepUp();
    if (!ch) return this.hasIdentity();
    return this.run(() => this.ipc.invoke('step_up_answer', { challengeId: ch.challengeId, answer }));
  }

  async logout(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      this.apply(await this.ipc.invoke('auth_logout', { bearer: this.bearer() }));
    } catch {
      // Best-effort — drop the local identity regardless so the UI reflects it.
      this._state.set({ status: 'anonymous' });
    } finally {
      this.busy.set(false);
    }
  }

  // --- prompt control ------------------------------------------------------

  /** Open the login/register dialog (the account affordance / a purchase gate). */
  openPrompt(reason: AuthPromptReason = 'account'): void {
    this.error.set(null);
    this._promptReason.set(reason);
    this._promptOpen.set(true);
  }

  /**
   * Close the dialog. If a purchase gate was awaiting, it resolves `false`
   * (dismissed) UNLESS a usable identity now exists.
   */
  closePrompt(): void {
    this._promptOpen.set(false);
    this.error.set(null);
    this.resolveGate(this.hasIdentity());
  }

  /**
   * Ensure there is a usable identity to buy with. Resolves immediately when one
   * already exists; otherwise raises the prompt and resolves when the user
   * obtains one (device or account) — or `false` if they dismiss it.
   */
  ensureForPurchase(): Promise<boolean> {
    if (this.hasIdentity()) return Promise.resolve(true);
    // Replace any prior gate (dismiss the old awaiter as not-ready).
    this.resolveGate(false);
    return new Promise<boolean>((resolve) => {
      this.pendingGate = resolve;
      this.openPrompt('purchase');
    });
  }

  // --- internals -----------------------------------------------------------

  /** Run one auth command with busy/error handling; returns whether it settled to an identity. */
  private async run(cmd: () => Promise<AuthState>): Promise<boolean> {
    this.busy.set(true);
    this.error.set(null);
    try {
      this.apply(await cmd());
      return this.hasIdentity();
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  private apply(state: AuthState): void {
    this._state.set(state);
    // Auto-close + release any purchase gate once a usable identity exists and no
    // step-up is outstanding.
    if (this.hasIdentity() && !this.stepUp()) {
      this._promptOpen.set(false);
      this.resolveGate(true);
    }
  }

  private resolveGate(ready: boolean): void {
    const gate = this.pendingGate;
    this.pendingGate = null;
    gate?.(ready);
  }
}
