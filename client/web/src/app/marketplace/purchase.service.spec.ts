import { TestBed } from '@angular/core/testing';
import { PurchaseService } from './purchase.service';
import { AuthService } from '../account/auth.service';
import { IPC_PORT, IpcPort, Unlisten } from '../ipc/ipc.port';
import { IpcCommand, IpcCommandMap, IpcEvent, SkillEnableResult, SkillId, SkillInstallResult } from '../ipc/contract';
import { SkillDetail } from './catalog.model';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = (args: any) => any;

/**
 * Records every invoked command (in call order) and resolves via a per-command
 * scripted handler set with {@link ScriptedIpc.when}. `auth_status` gets a safe
 * default (`anonymous`) from construction — `AuthService`'s constructor calls it
 * as a DI side effect of `PurchaseService` injecting `AuthService`, before any
 * test gets a chance to register its own stub — and is excluded from the
 * recorded {@link calls} sequence so it never pollutes a command-order assertion.
 */
class ScriptedIpc extends IpcPort {
  readonly calls: { cmd: IpcCommand; args: unknown }[] = [];
  private readonly handlers = new Map<IpcCommand, AnyHandler>();

  constructor() {
    super();
    this.handlers.set('auth_status', () => ({ status: 'anonymous' }));
  }

  when<K extends IpcCommand>(
    cmd: K,
    handler: (args: IpcCommandMap[K]['args']) => IpcCommandMap[K]['result'] | Promise<IpcCommandMap[K]['result']>
  ): void {
    this.handlers.set(cmd, handler as AnyHandler);
  }

  async invoke<K extends IpcCommand>(cmd: K, args: IpcCommandMap[K]['args']): Promise<IpcCommandMap[K]['result']> {
    if (cmd !== 'auth_status') this.calls.push({ cmd, args });
    const handler = this.handlers.get(cmd);
    if (!handler) return undefined as IpcCommandMap[K]['result'];
    return handler(args);
  }

  on<K extends IpcEvent>(): Unlisten {
    return () => undefined;
  }
}

/** A structurally-complete `SkillDetail` fixture — only the fields `buy()`/`install()` read matter. */
function detail(id: string, version = '1.0.0'): SkillDetail {
  return {
    id,
    name: 'Demo Skill',
    category: 'other',
    is_free: false,
    status: 'published',
    price: { amount: 500, currency: 'USD' },
    compressed_prompt: null,
    has_preview: false,
    min_model_tier: null,
    requirements: null,
    current_version: {
      version,
      min_app_version: null,
      size: null,
      sha256: null,
      is_current: true,
      changelog: null,
      status: 'published',
    },
    changelog: null,
    owned: false,
  };
}

/** Poll a condition with real timers — used for the `buy()` end-to-end test, which drives the
 * service's real (900ms-start) poll backoff rather than faking it. */
async function waitUntil(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const DOWNLOAD_URL = 'https://blob.example/skills/demo-skill/1.0.0.hpskill?sig=abc';
const INSTALL_RESULT: SkillInstallResult = {
  skillId: 'demo-skill',
  version: '1.0.0',
  dir: '/skills/demo-skill',
  state: 'installed_disabled',
};
// `SkillEnableResult.skill_id` is P0's fixed 2-value `SkillId` union, which predates the
// general P1 marketplace catalog `install`/`enable` deal with (see purchase.service.ts's
// `skillId as SkillId` cast at the call site) — the cast here mirrors that same known gap.
const ENABLE_RESULT: SkillEnableResult = {
  skill_id: 'demo-skill' as unknown as SkillId,
  persona_injected: true,
  tools_registered: [],
  panels: [],
};

describe('PurchaseService — real .hpskill install wiring (Task 9)', () => {
  let ipc: ScriptedIpc;
  let purchase: PurchaseService;

  beforeEach(() => {
    ipc = new ScriptedIpc();
    TestBed.configureTestingModule({
      providers: [{ provide: IPC_PORT, useValue: ipc }],
    });
    purchase = TestBed.inject(PurchaseService);
  });

  // --- install() — the method this task rewires -----------------------------

  it('install(id, true) runs license_fetch -> download_url -> skill_download_install -> skill_enable, in order, threading the download URL through, and reaches "active"', async () => {
    ipc.when('license_fetch', () => ({ compactJws: 'lic.jws' }));
    ipc.when('download_url', () => ({ url: DOWNLOAD_URL, expiresAt: '2026-01-01T00:00:00Z', watermark: 'wm' }));
    ipc.when('skill_download_install', () => ({ ...INSTALL_RESULT }));
    ipc.when('skill_enable', () => ({ ...ENABLE_RESULT }));

    await purchase.install('demo-skill', true);

    expect(ipc.calls.map((c) => c.cmd)).toEqual([
      'license_fetch',
      'download_url',
      'skill_download_install',
      'skill_enable',
    ]);

    // The signed URL `download_url` grants is the ONE thing the install command
    // needs — the webview never handles the package bytes themselves.
    const installCall = ipc.calls.find((c) => c.cmd === 'skill_download_install')!;
    expect((installCall.args as { url: string }).url).toBe(DOWNLOAD_URL);

    expect(purchase.stateFor('demo-skill')).toBe('active');
    expect(purchase.errorFor('demo-skill')).toBeNull();
  });

  it('install(id) without thenEnable stops at "installed" and never calls skill_enable', async () => {
    ipc.when('license_fetch', () => ({ compactJws: 'lic.jws' }));
    ipc.when('download_url', () => ({ url: DOWNLOAD_URL, expiresAt: '2026-01-01T00:00:00Z', watermark: 'wm' }));
    ipc.when('skill_download_install', () => ({ ...INSTALL_RESULT }));

    await purchase.install('demo-skill');

    expect(ipc.calls.map((c) => c.cmd)).toEqual(['license_fetch', 'download_url', 'skill_download_install']);
    expect(purchase.stateFor('demo-skill')).toBe('installed');
  });

  it('a rejected skill_download_install reverts state to "not-owned", surfaces CmdError::Package via errorFor, and never calls skill_enable', async () => {
    ipc.when('license_fetch', () => ({ compactJws: 'lic.jws' }));
    ipc.when('download_url', () => ({ url: DOWNLOAD_URL, expiresAt: '2026-01-01T00:00:00Z', watermark: 'wm' }));
    ipc.when('skill_download_install', () =>
      Promise.reject(new Error('skill package error: package signature verification failed: unknown kid'))
    );

    await purchase.install('demo-skill', true);

    expect(ipc.calls.map((c) => c.cmd)).toEqual(['license_fetch', 'download_url', 'skill_download_install']);
    expect(purchase.stateFor('demo-skill')).toBe('not-owned');
    expect(purchase.errorFor('demo-skill')).toBe('skill package error: package signature verification failed: unknown kid');
  });

  it('a rejected download_url never reaches the install command and reverts state, not leaving it stuck at "installing"', async () => {
    ipc.when('license_fetch', () => ({ compactJws: 'lic.jws' }));
    ipc.when('download_url', () => Promise.reject(new Error('backend request failed: network error')));

    await purchase.install('demo-skill', true);

    expect(ipc.calls.map((c) => c.cmd)).toEqual(['license_fetch', 'download_url']);
    expect(purchase.stateFor('demo-skill')).toBe('not-owned');
    expect(purchase.errorFor('demo-skill')).toBe('backend request failed: network error');
  });

  it('a rejected license_fetch never reaches download_url or install', async () => {
    ipc.when('license_fetch', () => Promise.reject(new Error('account store error: no session')));

    await purchase.install('demo-skill', true);

    expect(ipc.calls.map((c) => c.cmd)).toEqual(['license_fetch']);
    expect(purchase.stateFor('demo-skill')).toBe('not-owned');
    expect(purchase.errorFor('demo-skill')).toBe('account store error: no session');
  });

  // --- the FULL pinned purchase sequence (B4 step 4, end to end) ------------

  it(
    'buy() drives the full pinned sequence order_checkout -> order_get -> license_fetch -> ' +
      'download_url -> skill_download_install -> skill_enable, and reaches "active"',
    async () => {
      // A usable identity ('device', not 'authenticated') so ensureForPurchase()
      // resolves immediately without opening the auth prompt, and WITHOUT tripping
      // the constructor's isAuthenticated()-watching effect that self-triggers
      // restore()/entitlements_refresh (that effect only fires on 'authenticated').
      const auth = TestBed.inject(AuthService);
      ipc.when('auth_status', () => ({ status: 'device', deviceId: 'dev-1' }));
      await auth.refreshStatus();

      ipc.when('order_checkout', () => ({ orderId: 'ord-1', checkoutUrl: 'https://checkout.example/ord-1' }));
      ipc.when('order_get', () => ({ orderId: 'ord-1', status: 'settled' }));
      ipc.when('license_fetch', () => ({ compactJws: 'lic.jws' }));
      ipc.when('download_url', () => ({ url: DOWNLOAD_URL, expiresAt: '2026-01-01T00:00:00Z', watermark: 'wm' }));
      ipc.when('skill_download_install', () => ({ ...INSTALL_RESULT }));
      ipc.when('skill_enable', () => ({ ...ENABLE_RESULT }));

      void purchase.buy(detail('demo-skill')); // fire-and-forget, exactly like the ownership button does

      await waitUntil(() => purchase.stateFor('demo-skill') === 'active');

      expect(ipc.calls.map((c) => c.cmd)).toEqual([
        'order_checkout',
        'order_get',
        'license_fetch',
        'download_url',
        'skill_download_install',
        'skill_enable',
      ]);
    }
  );
});
