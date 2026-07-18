import { TestBed } from '@angular/core/testing';
import { PurchaseService } from './purchase.service';
import { AuthService } from '../account/auth.service';
import { EnabledSkillsService } from '../composition/enabled-skills.service';
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

/**
 * Establish a usable ('device') identity — mirrors what a REAL `device_ensure`
 * now does server-side (P0 fix) — so `install()`'s identity gate short-circuits
 * before it's even reached, and the tests that use this stay focused on the
 * license/download/install command sequence rather than the gate itself. The
 * anonymous-start gating behaviour has its own dedicated tests below.
 */
async function withDeviceIdentity(ipc: ScriptedIpc): Promise<AuthService> {
  const auth = TestBed.inject(AuthService);
  ipc.when('auth_status', () => ({ status: 'device' as const, deviceId: 'dev-1' }));
  await auth.refreshStatus();
  return auth;
}

const DOWNLOAD_URL = 'https://blob.example/skills/demo-skill/1.0.0.hpskill?sig=abc';
const INSTALL_RESULT: SkillInstallResult = {
  skillId: 'demo-skill',
  version: '1.0.0',
  dir: '/skills/demo-skill',
  state: 'installed_disabled',
};
const ENABLE_RESULT: SkillEnableResult = {
  skill_id: 'kitchen-timer' as SkillId,
  persona_injected: true,
  tools_registered: [],
  panels: [],
};

describe('PurchaseService — real .hpskill install wiring (Task 9)', () => {
  let ipc: ScriptedIpc;
  let purchase: PurchaseService;
  let enabledSkills: EnabledSkillsService;

  beforeEach(() => {
    ipc = new ScriptedIpc();
    TestBed.configureTestingModule({
      providers: [{ provide: IPC_PORT, useValue: ipc }],
    });
    purchase = TestBed.inject(PurchaseService);
    enabledSkills = TestBed.inject(EnabledSkillsService);
  });

  // --- install() — the method this task rewires -----------------------------

  it(
    'install(id, true) for a NON-P0 marketplace skill runs license_fetch -> download_url -> ' +
      "skill_download_install (NEVER skill_enable — Task 14/F03), threading the download URL " +
      "through, routes enable() through EnabledSkillsService, and reaches 'active'",
    async () => {
      await withDeviceIdentity(ipc);
      ipc.when('license_fetch', () => ({ compactJws: 'lic.jws' }));
      ipc.when('download_url', () => ({ url: DOWNLOAD_URL, expiresAt: '2026-01-01T00:00:00Z', watermark: 'wm' }));
      ipc.when('skill_download_install', () => ({ ...INSTALL_RESULT }));
      // Registered but must NEVER be invoked for a non-P0 id — its arg is P0's
      // fixed 2-value SkillId enum and can't deserialize 'demo-skill' (F03).
      ipc.when('skill_enable', () => ({ ...ENABLE_RESULT }));

      await purchase.install('demo-skill', true);

      expect(ipc.calls.map((c) => c.cmd)).toEqual(['license_fetch', 'download_url', 'skill_download_install']);

      // The signed URL `download_url` grants is the ONE thing the install command
      // needs — the webview never handles the package bytes themselves.
      const installCall = ipc.calls.find((c) => c.cmd === 'skill_download_install')!;
      expect((installCall.args as { url: string }).url).toBe(DOWNLOAD_URL);

      // F03/F07: routed through the client-side enablement store instead —
      // this is what makes CompositionService actually compose it.
      expect(enabledSkills.has('demo-skill')).toBe(true);

      expect(purchase.stateFor('demo-skill')).toBe('active');
      expect(purchase.errorFor('demo-skill')).toBeNull();
    }
  );

  it(
    'install(id, true) for a P0 skill (kitchen-timer) still calls skill_enable (unchanged ' +
      'behaviour) and does NOT add it to EnabledSkillsService (that store is for non-P0 ids only)',
    async () => {
      await withDeviceIdentity(ipc);
      ipc.when('license_fetch', () => ({ compactJws: 'lic.jws' }));
      ipc.when('download_url', () => ({ url: DOWNLOAD_URL, expiresAt: '2026-01-01T00:00:00Z', watermark: 'wm' }));
      ipc.when('skill_download_install', () => ({ ...INSTALL_RESULT }));
      ipc.when('skill_enable', () => ({ ...ENABLE_RESULT }));

      await purchase.install('kitchen-timer', true);

      expect(ipc.calls.map((c) => c.cmd)).toEqual([
        'license_fetch',
        'download_url',
        'skill_download_install',
        'skill_enable',
      ]);
      expect(enabledSkills.has('kitchen-timer')).toBe(false);
      expect(purchase.stateFor('kitchen-timer')).toBe('active');
    }
  );

  it('install(id) without thenEnable stops at "installed" and never calls skill_enable', async () => {
    await withDeviceIdentity(ipc);
    ipc.when('license_fetch', () => ({ compactJws: 'lic.jws' }));
    ipc.when('download_url', () => ({ url: DOWNLOAD_URL, expiresAt: '2026-01-01T00:00:00Z', watermark: 'wm' }));
    ipc.when('skill_download_install', () => ({ ...INSTALL_RESULT }));

    await purchase.install('demo-skill');

    expect(ipc.calls.map((c) => c.cmd)).toEqual(['license_fetch', 'download_url', 'skill_download_install']);
    expect(purchase.stateFor('demo-skill')).toBe('installed');
  });

  it('a rejected skill_download_install reverts state to "not-owned", surfaces CmdError::Package via errorFor, and never calls skill_enable', async () => {
    await withDeviceIdentity(ipc);
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
    await withDeviceIdentity(ipc);
    ipc.when('license_fetch', () => ({ compactJws: 'lic.jws' }));
    ipc.when('download_url', () => Promise.reject(new Error('backend request failed: network error')));

    await purchase.install('demo-skill', true);

    expect(ipc.calls.map((c) => c.cmd)).toEqual(['license_fetch', 'download_url']);
    expect(purchase.stateFor('demo-skill')).toBe('not-owned');
    expect(purchase.errorFor('demo-skill')).toBe('backend request failed: network error');
  });

  it('a rejected license_fetch never reaches download_url or install', async () => {
    await withDeviceIdentity(ipc);
    ipc.when('license_fetch', () => Promise.reject(new Error('account store error: no session')));

    await purchase.install('demo-skill', true);

    expect(ipc.calls.map((c) => c.cmd)).toEqual(['license_fetch']);
    expect(purchase.stateFor('demo-skill')).toBe('not-owned');
    expect(purchase.errorFor('demo-skill')).toBe('account store error: no session');
  });

  // --- Bug A1 fix: a FREE skill needs no license (never call license_fetch) --

  it(
    'install(id, false, true) for a FREE skill skips license_fetch entirely and runs ' +
      'download_url -> skill_download_install, reaching "installed"',
    async () => {
      await withDeviceIdentity(ipc);
      // Registered but must NEVER be invoked for a free skill — the real backend 403s
      // `step_up_required` here (no paid entitlement to license), which is exactly bug A1.
      ipc.when('license_fetch', () => Promise.reject(new Error('step_up_required')));
      ipc.when('download_url', () => ({ url: DOWNLOAD_URL, expiresAt: '2026-01-01T00:00:00Z', watermark: 'wm' }));
      ipc.when('skill_download_install', () => ({ ...INSTALL_RESULT }));

      await purchase.install('demo-skill', false, /* isFree */ true);

      expect(ipc.calls.map((c) => c.cmd)).toEqual(['download_url', 'skill_download_install']);
      expect(purchase.stateFor('demo-skill')).toBe('installed');
      expect(purchase.errorFor('demo-skill')).toBeNull();
    }
  );

  it('install(id, true, true) for a FREE skill installs and enables without ever calling license_fetch', async () => {
    await withDeviceIdentity(ipc);
    ipc.when('license_fetch', () => Promise.reject(new Error('step_up_required')));
    ipc.when('download_url', () => ({ url: DOWNLOAD_URL, expiresAt: '2026-01-01T00:00:00Z', watermark: 'wm' }));
    ipc.when('skill_download_install', () => ({ ...INSTALL_RESULT }));

    await purchase.install('demo-skill', true, true);

    expect(ipc.calls.map((c) => c.cmd)).toEqual(['download_url', 'skill_download_install']);
    expect(enabledSkills.has('demo-skill')).toBe(true);
    expect(purchase.stateFor('demo-skill')).toBe('active');
  });

  it(
    'dispatch(detail, "install") for a skill whose SkillDetail.is_free is true routes to install() ' +
      'with isFree=true, so license_fetch is never called (the "Get · Free" button, end to end)',
    async () => {
      await withDeviceIdentity(ipc);
      ipc.when('license_fetch', () => Promise.reject(new Error('step_up_required')));
      ipc.when('download_url', () => ({ url: DOWNLOAD_URL, expiresAt: '2026-01-01T00:00:00Z', watermark: 'wm' }));
      ipc.when('skill_download_install', () => ({ ...INSTALL_RESULT }));

      purchase.dispatch({ ...detail('free-skill'), is_free: true }, 'install');
      await waitUntil(() => purchase.stateFor('free-skill') === 'installed');

      expect(ipc.calls.map((c) => c.cmd)).toEqual(['download_url', 'skill_download_install']);
      expect(purchase.errorFor('free-skill')).toBeNull();
    }
  );

  it(
    'dispatch(detail, "install") for a PAID skill (is_free=false) still calls license_fetch ' +
      '(the paid path is unchanged)',
    async () => {
      await withDeviceIdentity(ipc);
      ipc.when('license_fetch', () => ({ compactJws: 'lic.jws' }));
      ipc.when('download_url', () => ({ url: DOWNLOAD_URL, expiresAt: '2026-01-01T00:00:00Z', watermark: 'wm' }));
      ipc.when('skill_download_install', () => ({ ...INSTALL_RESULT }));

      purchase.dispatch(detail('paid-skill'), 'install'); // detail()'s default is_free: false
      await waitUntil(() => purchase.stateFor('paid-skill') === 'installed');

      expect(ipc.calls.map((c) => c.cmd)).toEqual(['license_fetch', 'download_url', 'skill_download_install']);
    }
  );

  // --- P0 fix: install()'s identity gate (an anonymous "Get") ---------------

  it(
    'install() for a still-anonymous user silently mints a device identity first ' +
      '(device_ensure, NOT the sign-in dialog) and then proceeds normally',
    async () => {
      ipc.when('device_ensure', () => ({ status: 'device' as const, deviceId: 'dev-1' }));
      ipc.when('license_fetch', () => ({ compactJws: 'lic.jws' }));
      ipc.when('download_url', () => ({ url: DOWNLOAD_URL, expiresAt: '2026-01-01T00:00:00Z', watermark: 'wm' }));
      ipc.when('skill_download_install', () => ({ ...INSTALL_RESULT }));

      const auth = TestBed.inject(AuthService);
      expect(auth.promptOpen()).toBe(false);

      await purchase.install('demo-skill');

      expect(ipc.calls.map((c) => c.cmd)).toEqual([
        'device_ensure',
        'license_fetch',
        'download_url',
        'skill_download_install',
      ]);
      expect(auth.promptOpen()).toBe(false); // never raised the sign-in dialog
      expect(purchase.stateFor('demo-skill')).toBe('installed');
    }
  );

  it('install() never re-mints a device identity once one already exists', async () => {
    await withDeviceIdentity(ipc);
    ipc.when('device_ensure', () => ({ status: 'device' as const, deviceId: 'dev-1' }));
    ipc.when('license_fetch', () => ({ compactJws: 'lic.jws' }));
    ipc.when('download_url', () => ({ url: DOWNLOAD_URL, expiresAt: '2026-01-01T00:00:00Z', watermark: 'wm' }));
    ipc.when('skill_download_install', () => ({ ...INSTALL_RESULT }));

    await purchase.install('demo-skill');

    expect(ipc.calls.map((c) => c.cmd)).toEqual(['license_fetch', 'download_url', 'skill_download_install']);
  });

  it(
    'install() reverts to "not-owned" with a clear error and never calls license_fetch ' +
      'when the anonymous device_ensure itself fails (e.g. backend unreachable)',
    async () => {
      ipc.when('device_ensure', () => Promise.reject(new Error('backend request failed: network error')));
      ipc.when('license_fetch', () => ({ compactJws: 'lic.jws' }));

      await purchase.install('demo-skill');

      expect(ipc.calls.map((c) => c.cmd)).toEqual(['device_ensure']);
      expect(purchase.stateFor('demo-skill')).toBe('not-owned');
      expect(purchase.errorFor('demo-skill')).toBe('We couldn’t install this skill.');
    }
  );

  // --- the FULL pinned purchase sequence (B4 step 4, end to end) ------------

  it(
    'buy() drives the full pinned sequence order_checkout -> order_get -> license_fetch -> ' +
      'download_url -> skill_download_install (NEVER skill_enable for a non-P0 id — Task 14/F03), ' +
      'reaches "active", and the skill ends up enabled via EnabledSkillsService',
    async () => {
      // A usable identity ('device', not 'authenticated') so ensureForPurchase()
      // resolves immediately without opening the auth prompt, and WITHOUT tripping
      // the constructor's isAuthenticated()-watching effect that self-triggers
      // restore()/entitlements_refresh (that effect only fires on 'authenticated').
      const auth = TestBed.inject(AuthService);
      ipc.when('auth_status', () => ({ status: 'device' as const, deviceId: 'dev-1' }));
      await auth.refreshStatus();

      ipc.when('order_checkout', () => ({ orderId: 'ord-1', checkoutUrl: 'https://checkout.example/ord-1' }));
      ipc.when('order_get', () => ({ orderId: 'ord-1', status: 'settled' }));
      ipc.when('license_fetch', () => ({ compactJws: 'lic.jws' }));
      ipc.when('download_url', () => ({ url: DOWNLOAD_URL, expiresAt: '2026-01-01T00:00:00Z', watermark: 'wm' }));
      ipc.when('skill_download_install', () => ({ ...INSTALL_RESULT }));
      // Registered but must NEVER be invoked — 'demo-skill' is not a P0 id.
      ipc.when('skill_enable', () => ({ ...ENABLE_RESULT }));

      void purchase.buy(detail('demo-skill')); // fire-and-forget, exactly like the ownership button does

      await waitUntil(() => purchase.stateFor('demo-skill') === 'active');

      expect(ipc.calls.map((c) => c.cmd)).toEqual([
        'order_checkout',
        'order_get',
        'license_fetch',
        'download_url',
        'skill_download_install',
      ]);
      expect(enabledSkills.has('demo-skill')).toBe(true);
    }
  );

  // --- Task 14 (F03/F07) — non-P0 enable/disable routing ---------------------

  it('enable(id) for a non-P0 skill never calls skill_enable, only EnabledSkillsService', async () => {
    ipc.when('skill_enable', () => ({ ...ENABLE_RESULT }));

    await purchase.enable('nutrition-coach');

    expect(ipc.calls.map((c) => c.cmd)).toEqual([]);
    expect(enabledSkills.has('nutrition-coach')).toBe(true);
    expect(purchase.stateFor('nutrition-coach')).toBe('active');
  });

  it('dispatch(detail, "disable") for a non-P0 skill removes it from EnabledSkillsService', () => {
    enabledSkills.enable('nutrition-coach');

    purchase.dispatch(detail('nutrition-coach'), 'disable');

    expect(enabledSkills.has('nutrition-coach')).toBe(false);
    expect(purchase.stateFor('nutrition-coach')).toBe('installed');
  });
});
