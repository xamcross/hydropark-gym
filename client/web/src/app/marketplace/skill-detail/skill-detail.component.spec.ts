import { TestBed } from '@angular/core/testing';
import { SkillDetailComponent } from './skill-detail.component';
import { CATALOG_PORT, CatalogPort } from '../catalog.port';
import { CatalogFilters, CatalogPage, Ownership, SkillDetail, SkillPreview } from '../catalog.model';
import { IPC_PORT, IpcPort, Unlisten } from '../../ipc/ipc.port';
import { IpcCommand, IpcCommandMap, IpcEvent } from '../../ipc/contract';
import { PurchaseService } from '../purchase.service';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = (args: any) => any;

/** Mirrors `tool_routing::disclose` / `Capability::disclosure_phrase` (Rust) exactly —
 * same phrases the real command and the mock-ipc service produce. */
const CAPABILITY_PHRASES: Record<string, string> = {
  timers: 'set timers',
  unit_conversion: 'convert units',
  list_management: 'manage a list',
  calculation: 'do calculations',
  date_math: 'do date math',
};

/** Records nothing by default; per-command handlers are set with `.when()`. Always answers
 * `capability_disclose` the same way the real command / mock-ipc service would. */
class ScriptedIpc extends IpcPort {
  private readonly handlers = new Map<IpcCommand, AnyHandler>();

  constructor() {
    super();
    this.handlers.set('auth_status', () => ({ status: 'anonymous' }));
    this.handlers.set('capability_disclose', (args: IpcCommandMap['capability_disclose']['args']) => {
      const caps = args.capabilities;
      if (caps.length === 0) return 'This skill uses no special capabilities.';
      return `This skill can: ${caps.map((c) => CAPABILITY_PHRASES[c] ?? c).join(', ')}`;
    });
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

class StubCatalogPort extends CatalogPort {
  constructor(
    private readonly detail: SkillDetail,
    private readonly ownershipState: Ownership
  ) {
    super();
  }
  getCatalog(_filters: CatalogFilters): Promise<CatalogPage> {
    return Promise.resolve({ items: [], next_cursor: null });
  }
  getDetail(_id: string): Promise<SkillDetail> {
    return Promise.resolve(this.detail);
  }
  ownership(_id: string): Promise<Ownership> {
    return Promise.resolve(this.ownershipState);
  }
  getPreview(_id: string): Promise<SkillPreview> {
    return Promise.reject(new Error('no preview in this test'));
  }
}

/** A structurally-complete `SkillDetail` fixture with `tools` set, so
 * `capabilitiesForTools` has something to derive (mirrors purchase.service.spec.ts's
 * `detail()` fixture, plus `tools`). `capabilities`, when passed, models the REAL
 * `CatalogIpcAdapter` path (F05) — undefined models the `ng serve` stub, which never
 * sets it. */
function detail(id: string, tools: string[], capabilities?: string[]): SkillDetail {
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
      version: '1.0.0',
      min_app_version: null,
      size: null,
      sha256: null,
      is_current: true,
      changelog: null,
      status: 'published',
    },
    changelog: null,
    owned: false,
    tools,
    capabilities,
  };
}

describe('SkillDetailComponent — install-time capability disclosure dialog (Task 10)', () => {
  const DETAIL = detail('demo-skill', ['start_timer', 'list_manage']);

  let ipc: ScriptedIpc;
  let purchase: PurchaseService;
  let component: SkillDetailComponent;
  let fixture: ReturnType<typeof TestBed.createComponent<SkillDetailComponent>>;

  beforeEach(() => {
    ipc = new ScriptedIpc();
    const catalog = new StubCatalogPort(DETAIL, { skill_id: 'demo-skill', state: 'not-owned' });

    TestBed.configureTestingModule({
      imports: [SkillDetailComponent],
      providers: [
        { provide: CATALOG_PORT, useValue: catalog },
        { provide: IPC_PORT, useValue: ipc },
      ],
    });

    fixture = TestBed.createComponent(SkillDetailComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('skillId', 'demo-skill');
    purchase = TestBed.inject(PurchaseService);
  });

  /** Detect + flush the initial `getDetail`/`ownership` load. */
  async function loaded(): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  /** Detect + flush the dialog's own `capability_disclose` fetch after it opens. */
  async function dialogSettled(): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  it('install opens the capability-consent dialog and does NOT dispatch yet', async () => {
    await loaded();
    const dispatchSpy = spyOn(purchase, 'dispatch');

    component.onAction('install');
    fixture.detectChanges();

    expect(component.consentOpen()).toBe(true);
    expect(dispatchSpy).not.toHaveBeenCalled();
    const dialog = (fixture.nativeElement as HTMLElement).querySelector('[role="dialog"]');
    expect(dialog).withContext('the consent dialog must be rendered in the DOM').toBeTruthy();
  });

  it('buy ALSO opens the dialog, not just install', async () => {
    await loaded();
    const dispatchSpy = spyOn(purchase, 'dispatch');

    component.onAction('buy');
    fixture.detectChanges();

    expect(component.consentOpen()).toBe(true);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('renders the "This skill can: …" disclosure text derived from the skill\'s tools', async () => {
    await loaded();
    component.onAction('install');
    await dialogSettled();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('This skill can: set timers, manage a list');
  });

  it('confirm calls PurchaseService.dispatch exactly once with the original action, then closes the dialog', async () => {
    await loaded();
    const dispatchSpy = spyOn(purchase, 'dispatch');
    component.onAction('install');
    await dialogSettled();

    component.onConsentConfirm();
    fixture.detectChanges();

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalledWith(DETAIL, 'install');
    expect(component.consentOpen()).toBe(false);
  });

  it('confirm on a "buy" intent dispatches "buy", not "install"', async () => {
    await loaded();
    const dispatchSpy = spyOn(purchase, 'dispatch');
    component.onAction('buy');
    await dialogSettled();

    component.onConsentConfirm();

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalledWith(DETAIL, 'buy');
  });

  it('cancel calls PurchaseService.dispatch ZERO times and closes with no state change', async () => {
    await loaded();
    const dispatchSpy = spyOn(purchase, 'dispatch');
    const actionSpy = jasmine.createSpy('action');
    component.action.subscribe(actionSpy);
    component.onAction('install');
    await dialogSettled();

    component.onConsentCancel();
    fixture.detectChanges();

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(actionSpy).not.toHaveBeenCalled();
    expect(component.consentOpen()).toBe(false);
  });

  it('cancelling then re-opening for a fresh install still dispatches correctly (pendingAction is reset)', async () => {
    await loaded();
    const dispatchSpy = spyOn(purchase, 'dispatch');
    component.onAction('install');
    await dialogSettled();
    component.onConsentCancel();

    component.onAction('install');
    await dialogSettled();
    component.onConsentConfirm();

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalledWith(DETAIL, 'install');
  });

  it('enable is NOT intercepted — dispatches immediately with no dialog', async () => {
    await loaded();
    const dispatchSpy = spyOn(purchase, 'dispatch');

    component.onAction('enable');
    fixture.detectChanges();

    expect(component.consentOpen()).toBe(false);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalledWith(DETAIL, 'enable');
  });

  it('disable and uninstall are NOT intercepted either', async () => {
    await loaded();
    const dispatchSpy = spyOn(purchase, 'dispatch');

    component.onAction('disable');
    component.onAction('uninstall');

    expect(component.consentOpen()).toBe(false);
    expect(dispatchSpy).toHaveBeenCalledTimes(2);
    expect(dispatchSpy.calls.argsFor(0)).toEqual([DETAIL, 'disable']);
    expect(dispatchSpy.calls.argsFor(1)).toEqual([DETAIL, 'uninstall']);
  });
});

describe('SkillDetailComponent — F05: real backend capabilities win over tools-derivation', () => {
  // The exact bug Task 10's review flagged: a real `CatalogIpcAdapter` detail carries
  // `capabilities` (from the backend's certified manifest data) but the derivable-from-`tools`
  // set would be different/empty. The dialog must disclose the REAL capabilities, not what
  // `tools` implies — proving `effectiveCapabilities` prefers `capabilities` when present.
  const REAL_DETAIL = detail('cooking-assistant', [], ['timers', 'unit_conversion', 'list_management']);

  let ipc: ScriptedIpc;
  let component: SkillDetailComponent;
  let fixture: ReturnType<typeof TestBed.createComponent<SkillDetailComponent>>;

  beforeEach(() => {
    ipc = new ScriptedIpc();
    const catalog = new StubCatalogPort(REAL_DETAIL, { skill_id: 'cooking-assistant', state: 'not-owned' });

    TestBed.configureTestingModule({
      imports: [SkillDetailComponent],
      providers: [
        { provide: CATALOG_PORT, useValue: catalog },
        { provide: IPC_PORT, useValue: ipc },
      ],
    });

    fixture = TestBed.createComponent(SkillDetailComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('skillId', 'cooking-assistant');
  });

  it('discloses the real capabilities even though `tools` is empty (would derive nothing)', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    component.onAction('install');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.consentCapabilities()).toEqual(['timers', 'unit_conversion', 'list_management']);
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('This skill can: set timers, convert units, manage a list');
  });
});

/**
 * Task 18: the "Try asking" sample-prompts section and the screenshots strip
 * (SPEC §11.1) already had a template + model shape (`SkillDetail.sample_prompts`
 * / `.media`) — this locks that the component actually RENDERS both: every
 * curated prompt string appears in the DOM, a media tile WITH a `uri` renders
 * as a real `<img>` (not a placeholder), and a tile WITHOUT one still renders
 * as the honest placeholder tile (never a broken-image fake).
 */
describe('SkillDetailComponent — sample prompts & screenshots render (Task 18)', () => {
  const DETAIL: SkillDetail = {
    id: 'kitchen-timer',
    name: 'Kitchen Timer & Units',
    category: 'Cooking',
    is_free: true,
    status: 'published',
    price: null,
    compressed_prompt: null,
    has_preview: false,
    min_model_tier: null,
    requirements: null,
    current_version: null,
    changelog: null,
    owned: true,
    sample_prompts: ['Set a 9 minute timer for the pasta.', "What's 350F in Celsius?"],
    media: [
      { alt: 'Kitchen Timer & Units — skill detail page', uri: 'screenshots/03-skill-detail-kitchen-timer.png' },
      { alt: 'Kitchen Timer & Units — live in a conversation (native-app capture pending)' },
    ],
  };

  let ipc: ScriptedIpc;
  let fixture: ReturnType<typeof TestBed.createComponent<SkillDetailComponent>>;

  beforeEach(() => {
    ipc = new ScriptedIpc();
    const catalog = new StubCatalogPort(DETAIL, { skill_id: 'kitchen-timer', state: 'active' });

    TestBed.configureTestingModule({
      imports: [SkillDetailComponent],
      providers: [
        { provide: CATALOG_PORT, useValue: catalog },
        { provide: IPC_PORT, useValue: ipc },
      ],
    });

    fixture = TestBed.createComponent(SkillDetailComponent);
    fixture.componentRef.setInput('skillId', 'kitchen-timer');
  });

  async function loaded(): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  it('renders every sample prompt under "Try asking"', async () => {
    await loaded();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Try asking');
    expect(text).toContain('Set a 9 minute timer for the pasta.');
    expect(text).toContain("What's 350F in Celsius?");
  });

  it('renders a real <img> for a media tile with a uri, and a placeholder for one without', async () => {
    await loaded();

    const el = fixture.nativeElement as HTMLElement;
    const img = el.querySelector('img.shot-img') as HTMLImageElement | null;
    expect(img).withContext('a media tile with a uri must render an <img>').toBeTruthy();
    expect(img?.getAttribute('src')).toBe('screenshots/03-skill-detail-kitchen-timer.png');

    const placeholders = el.querySelectorAll('.shot-ph');
    expect(placeholders.length).withContext('the tile with no uri must still render as an honest placeholder').toBe(1);
  });
});
