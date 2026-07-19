import { Injectable, Signal, computed, signal } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { SkillId } from '../ipc/contract';
import { isTauriRuntime } from '../ipc/tauri-ipc.service';
import { SKILL_ID as PAID_SKILL_ID, generateUnlockCode, verifyUnlockCode } from './unlock-code';

/**
 * Owns the app's "which skills are unlocked" state for Phase 0 (P0-05.5) and is
 * the SINGLE SEAM the rest of the app reads unlock state through.
 *
 *   >> THROWAWAY VALIDATION PROTOTYPE. NOT the production entitlement system. <<
 *
 * Free skills are always unlocked; the one paid skill (`cooking-assistant`) is
 * locked until the buyer redeems the emailed one-time code (PHASE0-PLAN §4c). The
 * unlock:
 *   - is verified with a real HMAC check (`unlock-code.ts`), not a length test;
 *   - persists across restarts — via the Rust core (`unlock.rs`, which owns the
 *     filesystem per IPC-CONTRACT.md) when running in the Tauri shell, and via
 *     `localStorage` in the standalone web/mock build (what `ng build`/`ng serve`
 *     run — no Rust, no model; see client/README.md).
 *
 * ── The seam for the skills work (the client/.../skills modules) ───────────────
 * The skills agent's paid-skill `is_unlocked` must READ this service, not re-check
 * codes itself. Inject `UnlockService` and use either:
 *     unlock.isUnlocked('cooking-assistant')          // synchronous boolean
 *     unlock.unlocked()['cooking-assistant']           // or the reactive signal
 *     unlock.cookingAssistantUnlocked()                // convenience computed
 * A paid skill's enable toggle should gate on this exactly the way
 * skill-toggle.component gates the free skill on session.kitchenSkillEnabled().
 */

export type RedeemResult =
  | { ok: true; status: 'unlocked' | 'already_unlocked'; skill_id: SkillId }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'error'; message: string };

/** Skills that ship free (always unlocked). Everything else must be redeemed. */
const FREE_SKILLS: readonly SkillId[] = ['kitchen-timer'];

const STORAGE_KEY = 'hydropark.phase0.unlock.v1';

interface PersistedUnlock {
  unlocked: boolean;
  /** The code's 8-char nonce (its stable id) — recorded so a re-entry is idempotent. */
  nonce?: string;
  redeemed_at_ms?: number;
}
type PersistedMap = Partial<Record<SkillId, PersistedUnlock>>;

@Injectable({ providedIn: 'root' })
export class UnlockService {
  private readonly _unlocked = signal<Record<SkillId, boolean>>({
    'kitchen-timer': true,
    'cooking-assistant': false,
  });

  /** Reactive unlock map — the reactive form of the seam described above. */
  readonly unlocked: Signal<Record<SkillId, boolean>> = this._unlocked.asReadonly();

  /** Convenience: is the one paid Phase-0 SKU unlocked? */
  readonly cookingAssistantUnlocked = computed(() => this._unlocked()[PAID_SKILL_ID as SkillId]);

  constructor() {
    void this.hydrate();
  }

  /** Synchronous read used by skill toggles / `is_unlocked`. Free skills are always true. */
  isUnlocked(skillId: SkillId): boolean {
    if (FREE_SKILLS.includes(skillId)) return true;
    return this._unlocked()[skillId] === true;
  }

  /**
   * Redeem a user-entered code. Under a real Tauri shell the Rust core is
   * authoritative (it verifies AND persists to disk); everywhere else — and as a
   * fallback if the Rust command isn't registered yet — the same HMAC check runs
   * in TS and the result is persisted to localStorage.
   */
  async redeem(rawCode: string): Promise<RedeemResult> {
    const code = rawCode.trim();
    if (!code) return { ok: false, reason: 'malformed', message: 'Enter a code first.' };

    if (isTauriRuntime()) {
      try {
        return this.applyRust(await invoke<RustRedeemResult>('unlock_redeem', { args: { code } }));
      } catch {
        // Command not registered yet (lead hasn't wired main.rs) or a bridge
        // error — fall through to the in-webview check so the flow still works.
      }
    }
    return this.redeemLocally(code);
  }

  /**
   * DEV-ONLY shortcut for the mock/demo build: mints a REAL valid code and
   * redeems it through the real path — so the "Simulate unlock (dev)" affordance
   * in skill-toggle.component exercises the actual HMAC verify, not a bypass.
   * The skills agent's `simulateUnlock()` can simply call this. No-op semantics
   * are identical to a buyer pasting their emailed code.
   */
  async devSimulateUnlock(): Promise<RedeemResult> {
    return this.redeemLocally(await generateUnlockCode());
  }

  /**
   * (Re)pull the persisted unlock state and apply it to the reactive signal.
   * Runs once at boot (constructor) AND again after a marketplace purchase of
   * `cooking-assistant` settles under a real Tauri build — see
   * `PurchaseService.enable()`, the other half of the paid-enable/dashboard-lock
   * bug fix: `skill_download_install` (main.rs) already persisted + flipped the
   * P0 gate for that purchase via `unlock.rs`'s `mark_unlocked_via_purchase`;
   * this just re-reads it into this signal, exactly like boot hydration does
   * for a returning buyer. Public (was a private, fire-and-forget `hydrate()`)
   * so callers can await it and react to a genuine failure.
   */
  async hydrate(): Promise<void> {
    if (isTauriRuntime()) {
      try {
        const s = await invoke<RustStatus>('unlock_status');
        if (s?.cooking_assistant_unlocked) this.setUnlocked(PAID_SKILL_ID as SkillId, true);
        return;
      } catch {
        // Command not registered yet (lead hasn't wired main.rs) or a bridge
        // error — fall through to the localStorage read so the flow still works.
      }
    }
    this.hydrateFromStorage();
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async redeemLocally(code: string): Promise<RedeemResult> {
    const outcome = await verifyUnlockCode(code);
    if (!outcome.ok) {
      return {
        ok: false,
        reason: outcome.reason,
        message:
          outcome.reason === 'malformed'
            ? "That doesn't look like a Hydropark unlock code."
            : "That code isn't valid — check it against the one in your email.",
      };
    }
    const skill = PAID_SKILL_ID as SkillId;
    const already = this.isUnlocked(skill);
    this.persist(skill, { unlocked: true, nonce: outcome.nonce, redeemed_at_ms: Date.now() });
    this.setUnlocked(skill, true);
    return { ok: true, status: already ? 'already_unlocked' : 'unlocked', skill_id: skill };
  }

  private applyRust(res: RustRedeemResult): RedeemResult {
    if (res.ok) {
      const skill = (res.skill_id ?? (PAID_SKILL_ID as SkillId)) as SkillId;
      this.setUnlocked(skill, true);
      // Mirror into localStorage so a later web/mock run reflects it too.
      this.persist(skill, { unlocked: true, redeemed_at_ms: Date.now() });
      return { ok: true, status: res.status ?? 'unlocked', skill_id: skill };
    }
    return { ok: false, reason: res.reason ?? 'error', message: res.message ?? 'Unlock failed.' };
  }

  private setUnlocked(skillId: SkillId, value: boolean): void {
    this._unlocked.update((m) => ({ ...m, [skillId]: value }));
  }

  private hydrateFromStorage(): void {
    const map = this.readStorage();
    for (const [skillId, rec] of Object.entries(map)) {
      if (rec?.unlocked) this.setUnlocked(skillId as SkillId, true);
    }
  }

  private persist(skillId: SkillId, rec: PersistedUnlock): void {
    try {
      const map = this.readStorage();
      map[skillId] = rec;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    } catch {
      // Private-mode / disabled storage: unlock still holds in-memory for the session.
    }
  }

  private readStorage(): PersistedMap {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as PersistedMap) : {};
    } catch {
      return {};
    }
  }
}

/** Shape returned by the Rust `unlock_redeem` command (unlock.rs) — snake_case. */
interface RustRedeemResult {
  ok: boolean;
  status?: 'unlocked' | 'already_unlocked';
  skill_id?: SkillId;
  reason?: 'malformed' | 'bad_signature' | 'error';
  message?: string;
}

/** Shape returned by the Rust `unlock_status` command (unlock.rs). */
interface RustStatus {
  cooking_assistant_unlocked: boolean;
}
