import { TestBed } from '@angular/core/testing';
import { CookingAssistantService } from './cooking-assistant.service';
import { UnlockService } from '../../unlock/unlock.service';
import { IPC_PORT, IpcPort, Unlisten } from '../../ipc/ipc.port';
import { IpcCommand, IpcCommandMap, IpcEvent, SkillEnableResult, SkillId } from '../../ipc/contract';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = (args: any) => any;

class ScriptedIpc extends IpcPort {
  readonly calls: { cmd: IpcCommand; args: unknown }[] = [];
  private readonly handlers = new Map<IpcCommand, AnyHandler>();

  when<K extends IpcCommand>(
    cmd: K,
    handler: (args: IpcCommandMap[K]['args']) => IpcCommandMap[K]['result'] | Promise<IpcCommandMap[K]['result']>
  ): void {
    this.handlers.set(cmd, handler as AnyHandler);
  }

  async invoke<K extends IpcCommand>(cmd: K, args: IpcCommandMap[K]['args']): Promise<IpcCommandMap[K]['result']> {
    this.calls.push({ cmd, args });
    const handler = this.handlers.get(cmd);
    if (!handler) return undefined as IpcCommandMap[K]['result'];
    return handler(args);
  }

  on<K extends IpcEvent>(): Unlisten {
    return () => undefined;
  }
}

const ENABLE_RESULT: SkillEnableResult = {
  skill_id: 'cooking-assistant' as SkillId,
  persona_injected: true,
  tools_registered: [],
  panels: [],
};

/** `UnlockService`'s persisted-unlock localStorage key (mirrors the same isolation
 * pattern in templates.service.spec.ts) — a real Storage the browser test runner
 * keeps across `TestBed` resets, so a prior test's `devSimulateUnlock()` would
 * otherwise leak the "cooking-assistant is unlocked" state into every test after
 * it (Jasmine's default test order is randomized, so this bites nondeterministically
 * without the clear below). */
const UNLOCK_STORAGE_KEY = 'hydropark.phase0.unlock.v1';

/**
 * Paid-enable / dashboard-lock bug fix (systematic-debugging task):
 * `CookingAssistantService.unlocked` is a pure computed VIEW of
 * `UnlockService.isUnlocked('cooking-assistant')` — the single source of truth
 * `PurchaseService`'s reconciliation seam now writes into after a real
 * marketplace purchase (see `purchase.service.spec.ts` and `unlock.rs`'s
 * `mark_unlocked_via_purchase`). This view itself was never the bug (it always
 * correctly delegated) — these tests pin that it really does react the moment
 * the source flips, and that `enable()`, which is unreachable while "Locked",
 * then actually calls the Rust `skill_enable` gate and flips the local
 * `enabled` signal the dashboard toggle and `CompositionService` read.
 */
describe('CookingAssistantService — unlock/enable gate (paid-enable/dashboard-lock bug)', () => {
  let ipc: ScriptedIpc;
  let cooking: CookingAssistantService;
  let unlock: UnlockService;

  beforeEach(() => {
    try {
      localStorage.removeItem(UNLOCK_STORAGE_KEY);
    } catch {
      /* storage unavailable in this runner — UnlockService degrades to locked-by-default */
    }
    ipc = new ScriptedIpc();
    TestBed.configureTestingModule({
      providers: [{ provide: IPC_PORT, useValue: ipc }],
    });
    unlock = TestBed.inject(UnlockService);
    cooking = TestBed.inject(CookingAssistantService);
  });

  it('starts LOCKED (default) and enable() is refused without ever calling IPC', async () => {
    expect(cooking.unlocked()).toBe(false);

    const ok = await cooking.enable();

    expect(ok).toBe(false);
    expect(cooking.enabled()).toBe(false);
    expect(ipc.calls.length).toBe(0);
  });

  it(
    "reflects UnlockService's signal the moment it flips — no separate wiring needed for the " +
      'dashboard toggle to un-lock once the reconciliation seam updates the single source of truth',
    async () => {
      expect(cooking.unlocked()).toBe(false);

      // Same call the reconciliation seam's web/mock branch makes
      // (PurchaseService.enable(), see purchase.service.spec.ts).
      const redeemed = await unlock.devSimulateUnlock();

      expect(redeemed.ok).toBe(true);
      expect(cooking.unlocked()).toBe(true);
    }
  );

  it('once unlocked, enable() calls skill_enable and flips enabled() (the compose-eligibility signal)', async () => {
    ipc.when('skill_enable', () => ({ ...ENABLE_RESULT }));
    await unlock.devSimulateUnlock();
    expect(cooking.unlocked()).toBe(true);

    const ok = await cooking.enable();

    expect(ok).toBe(true);
    expect(cooking.enabled()).toBe(true);
    // Only skill_enable matters here — enable() also fires a telemetry.skillEnabled()
    // beacon (an incidental side effect of the SAME call, not the reconciliation this
    // spec is about), so assert membership/args rather than the full call sequence.
    const skillEnableCalls = ipc.calls.filter((c) => c.cmd === 'skill_enable');
    expect(skillEnableCalls.length).toBe(1);
    expect(skillEnableCalls[0].args).toEqual({ skill_id: 'cooking-assistant' });
  });
});
