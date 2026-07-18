import { DestroyRef, Injectable, effect, inject, signal } from '@angular/core';
import { IPC_PORT } from '../ipc/ipc.port';
import { isTauriRuntime } from '../ipc/tauri-ipc.service';
import { EntitlementItem, PurchaseCallbackEvent, SkillId } from '../ipc/contract';
import { NotificationService } from '../shared/notify/notification.service';
import { SystemBrowserService } from '../shared/system-browser.service';
import { TelemetryService } from '../state/telemetry.service';
import { UnlockService } from '../unlock/unlock.service';
import { AuthService } from '../account/auth.service';
import { EnabledSkillsService } from '../composition/enabled-skills.service';
import { OwnershipAction, OwnershipState, SkillDetail } from './catalog.model';

/**
 * P0's fixed-catalog skill ids — the only two the Rust `skill_enable` command
 * can deserialize (its arg is the 2-value `SkillId` enum, predating the
 * general P1 marketplace catalog). Used to branch `enable`/`disable` so an
 * arbitrary marketplace id (e.g. `nutrition-coach`) never reaches that IPC
 * call (F03) and instead routes through {@link EnabledSkillsService} (F07).
 */
const P0_SKILL_IDS: ReadonlySet<string> = new Set<SkillId>(['kitchen-timer', 'cooking-assistant']);

function isP0SkillId(id: string): id is SkillId {
  return P0_SKILL_IDS.has(id);
}

/** Backoff schedule for `order_get` polling while the browser checkout runs. */
const POLL_START_MS = 900;
const POLL_MAX_MS = 5000;
const POLL_BACKOFF = 1.6;
/** Give the buyer a few minutes to finish in the browser before we give up polling. */
const POLL_MAX_WAIT_MS = 3 * 60 * 1000;

/** Fallback region until locale/region threads through (mirrors the catalog adapter). */
const DEFAULT_REGION = 'US';

/**
 * The purchase / ownership-lifecycle orchestrator (P1-08.5/.6/.8). It is the
 * single source of truth for the LIVE ownership state of each skill this session
 * — an override layered over whatever baseline the {@link CatalogPort} first
 * reported — and it drives every ownership-button intent to real IPC.
 *
 * BUY (P1-08.6): ensure a usable identity (prompt if needed) → `order_checkout`
 * → hand the checkout URL to the system browser → `purchasing` state → settle on
 * WHICHEVER of (a) `order_get` polling with backoff or (b) the `purchase://
 * callback` deep-link arrives first → `license_fetch` + `download_url` → install
 * + enable the skill.
 *
 * RESTORE (P1-08.8): once authenticated, `entitlements_refresh` marks owned
 * skills so the ownership button offers re-download / enable.
 *
 * Under `ng serve` the mock IPC simulates checkout, the settle callback,
 * licensing and download, so the whole loop is demonstrable with no backend.
 */
@Injectable({ providedIn: 'root' })
export class PurchaseService {
  private readonly ipc = inject(IPC_PORT);
  private readonly auth = inject(AuthService);
  private readonly notify = inject(NotificationService);
  private readonly browser = inject(SystemBrowserService);
  private readonly telemetry = inject(TelemetryService);
  private readonly unlock = inject(UnlockService);
  private readonly enabledSkills = inject(EnabledSkillsService);

  /** Per-skill live ownership override (keyed by skillId). Read via {@link stateFor}. */
  private readonly overrides = signal<Record<string, OwnershipState>>({});
  /** Per-skill recoverable error (surfaced non-destructively on the button). */
  private readonly errors = signal<Record<string, string>>({});
  /** True while a restore is in flight. */
  readonly restoring = signal(false);

  /** skillId → last-known current version, for `download_url` on install/restore. */
  private readonly versions = new Map<string, string>();
  /** orderId → skillId for in-flight orders. */
  private readonly pendingOrders = new Map<string, string>();
  /** orderIds already settled (dedupe poll vs. deep-link callback). */
  private readonly settledOrders = new Set<string>();

  constructor() {
    // Settle signal #2: the deep-link return from the system browser.
    const unlisten = this.ipc.on('purchase://callback', (e) => this.onCallback(e));
    inject(DestroyRef).onDestroy(unlisten);

    // Restore purchases automatically the moment an account is present (P1-08.8).
    let wasAuthed = false;
    effect(() => {
      const authed = this.auth.isAuthenticated();
      if (authed && !wasAuthed) void this.restore();
      wasAuthed = authed;
    });
  }

  // --- reads (bound by the ownership button / detail view) -----------------

  /** The live override state for a skill, or `undefined` to fall back to the port baseline. */
  stateFor(skillId: string): OwnershipState | undefined {
    return this.overrides()[skillId];
  }

  errorFor(skillId: string): string | null {
    return this.errors()[skillId] ?? null;
  }

  // --- intent routing ------------------------------------------------------

  /** Route an ownership-button intent to the real flow. */
  dispatch(detail: SkillDetail, action: OwnershipAction): void {
    if (detail.current_version?.version) this.versions.set(detail.id, detail.current_version.version);
    switch (action) {
      case 'buy':
        void this.buy(detail);
        return;
      case 'install':
        // A FREE skill needs no license (bug A1) — the SkillDetail here is the one place that
        // reliably knows `is_free`, so thread it straight through. Every other caller of
        // `install()` either has no SkillDetail at all (defaults to the paid path, unchanged
        // behaviour) or is already known-paid (a settled `buy()`, see `onSettled` below).
        void this.install(detail.id, /* thenEnable */ false, detail.is_free);
        return;
      case 'enable':
        void this.enable(detail.id);
        return;
      case 'disable':
        // Non-P0 skills are only ever enabled through EnabledSkillsService
        // (see `enable` below), so disabling must undo that exact same store
        // membership — P0 skills are untouched here (unchanged behaviour).
        if (!isP0SkillId(detail.id)) this.enabledSkills.disable(detail.id);
        this.setState(detail.id, 'installed');
        return;
      case 'uninstall':
        this.setState(detail.id, 'owned-not-installed');
        return;
    }
  }

  // --- buy (P1-08.6) -------------------------------------------------------

  async buy(detail: SkillDetail): Promise<void> {
    const skillId = detail.id;
    this.clearError(skillId);

    // 1) Identity gate — the ONLY thing that requires an account. Prompt if none.
    const ready = await this.auth.ensureForPurchase();
    if (!ready) return; // dismissed — leave the state untouched (still not-owned).

    this.setState(skillId, 'purchasing');
    try {
      this.telemetry.noteBackendCall();
      const { orderId, checkoutUrl } = await this.ipc.invoke('order_checkout', {
        targetId: skillId,
        region: DEFAULT_REGION,
        bearer: this.auth.bearer(),
      });
      this.pendingOrders.set(orderId, skillId);

      // 2) Hand the checkout URL to the system browser (never navigate the webview).
      await this.browser.open(checkoutUrl);
      this.notify.toast({
        title: 'Complete your purchase',
        body: 'Finish checkout in your browser — this window updates automatically.',
        severity: 'info',
      });

      // 3) Race the poll against the deep-link callback; first to settle wins.
      void this.pollOrder(orderId, skillId);
    } catch (e) {
      this.fail(skillId, e, 'We couldn’t start checkout.');
    }
  }

  private async pollOrder(orderId: string, skillId: string): Promise<void> {
    const started = Date.now();
    let delay = POLL_START_MS;
    while (!this.settledOrders.has(orderId) && this.pendingOrders.has(orderId)) {
      if (Date.now() - started > POLL_MAX_WAIT_MS) {
        // Timed out. Don't strand the button in "purchasing" — revert and point
        // at Restore, which reconciles from entitlements once the webhook lands.
        if (!this.settledOrders.has(orderId)) {
          this.pendingOrders.delete(orderId);
          this.setState(skillId, 'not-owned');
          this.setError(
            skillId,
            'We couldn’t confirm the purchase yet. If you completed checkout, use “Restore purchases”.'
          );
        }
        return;
      }
      await sleep(delay);
      if (this.settledOrders.has(orderId) || !this.pendingOrders.has(orderId)) return;
      try {
        this.telemetry.noteBackendCall();
        const res = await this.ipc.invoke('order_get', { orderId, bearer: this.auth.bearer() });
        if (isSettled(res.status)) {
          void this.onSettled(orderId, skillId);
          return;
        }
        if (isTerminalFailure(res.status)) {
          this.pendingOrders.delete(orderId);
          this.setState(skillId, 'not-owned');
          this.setError(skillId, 'Checkout was cancelled — you were not charged.');
          return;
        }
      } catch {
        // Transient — keep polling under backoff.
      }
      delay = Math.min(POLL_MAX_MS, Math.round(delay * POLL_BACKOFF));
    }
  }

  /** Deep-link settle (P1-08.6). Matches by orderId when present, else by skillId. */
  private onCallback(e: PurchaseCallbackEvent): void {
    const orderId = e.orderId ?? undefined;
    const skillId =
      (orderId && this.pendingOrders.get(orderId)) ??
      e.skillId ??
      undefined;
    if (!skillId) return;

    if (isSettled(e.status)) {
      void this.onSettled(orderId ?? `cb:${skillId}`, skillId);
    } else if (isTerminalFailure(e.status)) {
      if (orderId) this.pendingOrders.delete(orderId);
      this.setState(skillId, 'not-owned');
      this.setError(skillId, 'Checkout was cancelled — you were not charged.');
    }
  }

  /**
   * Runs exactly once per order: refresh entitlements, then fetch license +
   * download, then install + enable.
   *
   * ── ROOT-CAUSE FIX — a freshly-settled purchase always installed NotOwned ──
   * SPEC §13.7: "The app refreshes `/entitlements` on every successful online
   * launch (and after any purchase)." The Rust installer's ownership gate
   * (`SkillInstaller::install_bytes`, hpskill.rs step 3) checks the LOCAL
   * `entitlements` cache via `is_entitled()` — but that cache is populated
   * ONLY by `entitlements_refresh` (`session.refresh_entitlements()` →
   * `store.cache_entitlements`), never by `license_fetch`, which just hands
   * back the signed JWS and is otherwise unused by the caller. Every paid buy
   * therefore called `install()` → `license_fetch` (succeeds) → `download_url`
   * (succeeds) → `skill_download_install` → `install_bytes`'s ownership check
   * with an EMPTY local entitlements cache → `Lifecycle(NotOwned)`, surfaced
   * to the user as the generic "We couldn't install this skill." banner.
   * `restore()` already does this same refresh; a device-only "continue on
   * this device" purchase never authenticates (`status` stays `"device"`,
   * not `"authenticated"`), so the constructor's auto-restore `effect()`
   * never fires for it either — this is the only path that populates the
   * cache before a fresh purchase's own install. Best-effort: a failed
   * refresh here must not strand the purchase — `install()`'s own
   * license_fetch/download_url still enforce ownership server-side, so a
   * transient refresh failure just means the ownership gate below (correctly)
   * rejects until the next successful refresh.
   * ──────────────────────────────────────────────────────────────────────────
   */
  private async onSettled(orderId: string, skillId: string): Promise<void> {
    if (this.settledOrders.has(orderId)) return;
    this.settledOrders.add(orderId);
    this.pendingOrders.delete(orderId);
    this.clearError(skillId);
    this.setState(skillId, 'owned-not-installed');
    try {
      this.telemetry.noteBackendCall();
      await this.ipc.invoke('entitlements_refresh', { bearer: this.auth.bearer() });
    } catch {
      // Best-effort — see the doc comment above.
    }
    void this.install(skillId, /* thenEnable */ true);
  }

  // --- install / enable (P1-08.5 lifecycle) --------------------------------

  /**
   * Owned → license_fetch → download_url → the REAL signed `.hpskill` fetch +
   * install (`skill_download_install`) → installed, optionally auto-enabling.
   *
   * The Rust core owns the byte fetch AND the install (verify signature →
   * re-validate manifest → compat gate → extract → register → persist,
   * `hpskill.rs`) — the webview CSP (`connect-src 'self'`) forbids fetching the
   * blob URL itself, and package bytes never cross the IPC boundary into JS.
   * `stateFor(id)` only advances to `'installed'` once that command RESOLVES; any
   * failure along the way (license, download-URL grant, or the install itself)
   * routes through {@link fail}, which reverts to `'not-owned'` and surfaces the
   * error via {@link errorFor} rather than leaving the button stuck mid-flow.
   *
   * A FREE skill needs no account (SPEC §12/§13 — the app is fully usable
   * anonymously), but `license_fetch`/`download_url` are still authed
   * server-side, so an identity is still required to attach a bearer. Unlike
   * {@link buy}, this must never raise the sign-in dialog (that framing —
   * "you need an account to buy skills" — is wrong for a free Get): it
   * silently mints a device identity via {@link AuthService.ensureDevice} when
   * none exists yet, the same no-email path the dialog's "Continue on this
   * device" button drives.
   *
   * ── BUG A1 FIX — a FREE skill needs NO license ───────────────────────────────
   * `license_fetch` (→ `POST /v1/licenses/issue`) requires step-up AND a paid
   * entitlement; a free skill has neither, so calling it unconditionally made
   * every free "Get" 403 with `step_up_required`. `isFree` (default `false`, so
   * every existing/paid call site is unchanged) skips `license_fetch` entirely
   * for a free skill and goes straight to `download_url` + `skill_download_install`
   * — the download itself only ever needed the device bearer. `dispatch()` passes
   * the real `SkillDetail.is_free` here (the one place that reliably knows it);
   * every other caller either has no detail (defaults to the paid/unchanged path)
   * or is already known-paid ({@link onSettled}, reached only via a real `buy()`).
   * ──────────────────────────────────────────────────────────────────────────────
   */
  async install(skillId: string, thenEnable = false, isFree = false): Promise<void> {
    this.clearError(skillId);
    if (!this.auth.hasIdentity()) {
      const ready = await this.auth.ensureDevice();
      if (!ready) {
        this.fail(skillId, undefined, 'We couldn’t install this skill.');
        return;
      }
    }
    this.setState(skillId, 'installing');
    try {
      const bearer = this.auth.bearer();
      if (!isFree) {
        this.telemetry.noteBackendCall();
        await this.ipc.invoke('license_fetch', { skillId, bearer });
      }

      const version = this.versions.get(skillId) ?? '1.0.0';
      this.telemetry.noteBackendCall();
      const { url } = await this.ipc.invoke('download_url', { skillId, version, bearer });

      this.telemetry.noteBackendCall();
      await this.ipc.invoke('skill_download_install', { url });

      this.setState(skillId, 'installed');
      if (thenEnable) await this.enable(skillId);
    } catch (e) {
      this.fail(skillId, e, 'We couldn’t install this skill.');
    }
  }

  /** Installed → enabling → active. Ties a real paid SKU into its in-app unlock. */
  async enable(skillId: string): Promise<void> {
    this.setState(skillId, 'enabling');
    if (isP0SkillId(skillId)) {
      try {
        // P0's fixed-catalog enable gate (kitchen-timer / cooking-assistant
        // only — it predates the general P1 marketplace catalog). Non-fatal on
        // rejection: a rejection must never strand an already-installed skill
        // mid-enable.
        await this.ipc.invoke('skill_enable', { skill_id: skillId });
      } catch {
        // See above — swallowed by design.
      }
    } else {
      // General marketplace skills (F03/F07): the Rust `skill_enable` IPC arg
      // is the fixed 2-value P0 `SkillId` enum and cannot deserialize an
      // arbitrary marketplace id, so calling it here would just be a silently
      // swallowed no-op that never actually enables anything. Route through
      // the client-side enablement store instead — CompositionService unions
      // it into `enabledManifests`, so the skill's panels/tools really compose.
      this.enabledSkills.enable(skillId);
    }
    // Close the loop for the one in-app paid SKU: a settled purchase unlocks the
    // Cooking Assistant so its Assistant-view toggle lights up. In a real Tauri
    // build the Rust core's post-purchase entitlement is authoritative and
    // UnlockService hydrates from it, so we only self-unlock in the web/mock demo.
    if (skillId === 'cooking-assistant' && !isTauriRuntime()) {
      try {
        await this.unlock.devSimulateUnlock();
      } catch {
        // Non-fatal — the marketplace state still reaches `active`.
      }
    }
    this.setState(skillId, 'active');
    this.notify.toast({ title: 'Ready to use', body: 'Skill installed and enabled.', severity: 'success' });
  }

  // --- restore purchases (P1-08.8) -----------------------------------------

  /** Re-pull the authed entitlement set and mark owned skills for re-download/enable. */
  async restore(): Promise<void> {
    if (this.restoring()) return;
    this.restoring.set(true);
    try {
      this.telemetry.noteBackendCall();
      const res = await this.ipc.invoke('entitlements_refresh', { bearer: this.auth.bearer() });
      let restored = 0;
      for (const ent of res.skills) {
        if (ent.version) this.versions.set(ent.skillId, ent.version);
        const next = entitlementToState(ent);
        // Never downgrade a skill that's already active/installing this session.
        if (this.rank(next) > this.rank(this.overrides()[ent.skillId])) {
          this.setState(ent.skillId, next);
          restored += 1;
        }
      }
      this.notify.toast({
        title: 'Purchases restored',
        body: restored
          ? `${restored} skill${restored === 1 ? '' : 's'} restored — install to use ${restored === 1 ? 'it' : 'them'}.`
          : 'Your account is up to date.',
        severity: 'info',
      });
    } catch (e) {
      this.notify.toast({
        title: 'Couldn’t restore purchases',
        body: e instanceof Error ? e.message : 'Please try again.',
        severity: 'critical',
      });
    } finally {
      this.restoring.set(false);
    }
  }

  // --- internals -----------------------------------------------------------

  private setState(skillId: string, state: OwnershipState): void {
    this.overrides.update((m) => ({ ...m, [skillId]: state }));
  }

  private setError(skillId: string, message: string): void {
    this.errors.update((m) => ({ ...m, [skillId]: message }));
  }

  private clearError(skillId: string): void {
    this.errors.update((m) => {
      if (!(skillId in m)) return m;
      const next = { ...m };
      delete next[skillId];
      return next;
    });
  }

  private fail(skillId: string, e: unknown, fallback: string): void {
    this.setState(skillId, 'not-owned');
    this.setError(skillId, e instanceof Error ? e.message : fallback);
  }

  /** Lifecycle ordering so restore only ever advances a skill, never rewinds it. */
  private rank(state: OwnershipState | undefined): number {
    switch (state) {
      case undefined:
      case 'not-owned':
        return 0;
      case 'purchasing':
        return 1;
      case 'owned-not-installed':
        return 2;
      case 'installing':
        return 3;
      case 'installed':
        return 4;
      case 'enabling':
        return 5;
      case 'active':
        return 6;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSettled(status: string): boolean {
  const s = status.toLowerCase();
  return s === 'settled' || s === 'paid' || s === 'complete' || s === 'completed' || s === 'succeeded';
}

function isTerminalFailure(status: string): boolean {
  const s = status.toLowerCase();
  return s === 'cancelled' || s === 'canceled' || s === 'failed' || s === 'expired';
}

/** An entitlement row → the SPEC §11.3 ownership state (mirrors the catalog adapter). */
function entitlementToState(ent: EntitlementItem): OwnershipState {
  switch (ent.state) {
    case 'active':
      return 'active';
    case 'installed':
      return 'installed';
    default:
      return 'owned-not-installed';
  }
}
