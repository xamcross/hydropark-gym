import { TestBed } from '@angular/core/testing';
import { CatalogIpcAdapter } from './catalog-ipc.adapter';
import { IPC_PORT, IpcPort, Unlisten } from '../ipc/ipc.port';
import { IpcCommand, IpcCommandMap, IpcEvent, SkillDetail as IpcSkillDetail } from '../ipc/contract';
import { effectiveCapabilities } from './catalog.model';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = (args: any) => any;

/** Mirrors the `ScriptedIpc` pattern used by `purchase.service.spec.ts` /
 * `skill-detail.component.spec.ts`: `auth_status` gets a safe default from
 * construction (AuthService's DI-time side effect), everything else is
 * scripted per test with {@link ScriptedIpc.when}. */
class ScriptedIpc extends IpcPort {
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
    const handler = this.handlers.get(cmd);
    if (!handler) return undefined as IpcCommandMap[K]['result'];
    return handler(args);
  }

  on<K extends IpcEvent>(): Unlisten {
    return () => undefined;
  }
}

/** A structurally-complete `catalog_detail` IPC result — only the fields under test vary. */
function ipcDetail(overrides: Partial<IpcSkillDetail>): IpcSkillDetail {
  return {
    id: 'cooking-assistant',
    name: 'Cooking Assistant',
    pitch: 'A hands-on offline cook.',
    category: 'kitchen',
    priceCents: 500,
    sizeBytes: 6_000_000,
    hardwareBadge: 'Runs on most PCs',
    ownership: 'not-owned',
    hasPreview: false,
    ...overrides,
  };
}

/**
 * F05 regression coverage: Task 10's review found that the real `catalog_detail`
 * path never populated `tools`, so `capabilitiesForTools` always derived `[]` and
 * the install-time capability-consent dialog showed "This skill uses no special
 * capabilities." for every real skill. This locks the fix — `CatalogIpcAdapter`
 * now maps the backend's real `capabilities` token array straight onto the
 * marketplace `SkillDetail`, which is the disclosure dialog's actual input via
 * `effectiveCapabilities` (`skill-detail.component.ts`).
 */
describe('CatalogIpcAdapter — F05: real capabilities reach the disclosure input', () => {
  let ipc: ScriptedIpc;
  let adapter: CatalogIpcAdapter;

  beforeEach(() => {
    ipc = new ScriptedIpc();
    TestBed.configureTestingModule({
      providers: [CatalogIpcAdapter, { provide: IPC_PORT, useValue: ipc }],
    });
    adapter = TestBed.inject(CatalogIpcAdapter);
  });

  it('maps the backend capability tokens onto SkillDetail.capabilities, non-empty', async () => {
    ipc.when('catalog_detail', () =>
      ipcDetail({ capabilities: ['timers', 'unit_conversion', 'list_management'] })
    );

    const detail = await adapter.getDetail('cooking-assistant');

    expect(detail.capabilities).toEqual(['timers', 'unit_conversion', 'list_management']);
    // The exact input the capability-consent dialog is opened with (Task 10 +
    // `skill-detail.component.ts#onAction`) — RED before the fix: this used to be `[]`
    // because `capabilities` didn't exist on SkillDetail and `tools` was never populated.
    expect(effectiveCapabilities(detail)).not.toEqual([]);
    expect(effectiveCapabilities(detail)).toEqual(['timers', 'unit_conversion', 'list_management']);
  });

  it('preserves each skill\'s distinct capability set (not a fixed/shared list)', async () => {
    ipc.when('catalog_detail', () => ipcDetail({ capabilities: ['list_management', 'date_math', 'calculation'] }));

    const detail = await adapter.getDetail('budget-bills');

    expect(detail.capabilities).toEqual(['list_management', 'date_math', 'calculation']);
  });

  it('defaults to an empty array (never undefined) when the backend omits capabilities', async () => {
    ipc.when('catalog_detail', () => ipcDetail({}));

    const detail = await adapter.getDetail('legacy-skill');

    expect(detail.capabilities).toEqual([]);
    // Still honest: an explicit empty array from the real adapter must NOT fall back to
    // deriving from `tools` (which the backend also never populates) — see
    // `catalog.model.ts#effectiveCapabilities`.
    expect(effectiveCapabilities(detail)).toEqual([]);
  });

  it('never derives capabilities from tools on the real path (tools stays whatever the backend sent)', async () => {
    // The backend never populates `tools` (see catalog.model.ts's header comment); this
    // asserts the adapter does not try to synthesize `capabilities` from it either.
    ipc.when('catalog_detail', () => ipcDetail({ tools: undefined, capabilities: ['timers'] }));

    const detail = await adapter.getDetail('kitchen-timer');

    expect(detail.tools).toBeUndefined();
    expect(detail.capabilities).toEqual(['timers']);
  });
});
