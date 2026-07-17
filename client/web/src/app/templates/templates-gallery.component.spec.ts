import { TestBed } from '@angular/core/testing';
import { TemplatesGalleryComponent } from './templates-gallery.component';
import { PurchaseService } from '../marketplace/purchase.service';
import { IPC_PORT, IpcPort, Unlisten } from '../ipc/ipc.port';
import { ComposedAgentView, IpcCommand, IpcCommandMap, IpcEvent, TemplateView } from '../ipc/contract';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = (args: any) => any;

const STUB_COMPOSED: ComposedAgentView = {
  order: [],
  primary: null,
  persona: '',
  tools: [],
  routing: [],
  capacity: { ctx_window: 4096, reserve_tokens: 0, skill_tokens: 0, used_tokens: 0, remaining: 4096, blocked: false, overflow: 0 },
};

const WEEKNIGHT_CHEF: TemplateView = {
  id: 'tmpl_weeknight_chef',
  name: 'Weeknight Chef',
  skill_refs: ['kitchen-timer', 'nutrition-coach'],
  base_model: 'qwen2.5-3b-instruct-q4_k_m',
};

class ScriptedIpc extends IpcPort {
  readonly calls: { cmd: IpcCommand; args: unknown }[] = [];
  private readonly handlers = new Map<IpcCommand, AnyHandler>();

  constructor() {
    super();
    this.handlers.set('auth_status', () => ({ status: 'anonymous' }));
    this.handlers.set('compose_agent', () => STUB_COMPOSED);
    this.handlers.set('template_list', () => [WEEKNIGHT_CHEF]);
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

describe('TemplatesGalleryComponent (Task 11b)', () => {
  let ipc: ScriptedIpc;
  let fixture: ReturnType<typeof TestBed.createComponent<TemplatesGalleryComponent>>;
  let component: TemplatesGalleryComponent;

  async function init(): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  beforeEach(() => {
    ipc = new ScriptedIpc();
    TestBed.configureTestingModule({
      imports: [TemplatesGalleryComponent],
      providers: [{ provide: IPC_PORT, useValue: ipc }],
    });
    fixture = TestBed.createComponent(TemplatesGalleryComponent);
    component = fixture.componentInstance;
  });

  it('lists templates from the service with their skill chips', async () => {
    await init();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Weeknight Chef');
    // 'kitchen-timer' resolves to its display name via the dev manifest registry.
    expect(text).toContain('Kitchen Timer & Units');
    // 'nutrition-coach' has no known manifest — falls back to the raw id.
    expect(text).toContain('nutrition-coach');
  });

  it('a fully successful Load emits `loaded`', async () => {
    await init();
    ipc.when('template_load', () => ({ ok: true, skill_ids: ['kitchen-timer'], ui_overrides: [], missing_skills: [] }));
    const loadedSpy = jasmine.createSpy('loaded');
    component.loaded.subscribe(loadedSpy);

    await component.onLoad('tmpl_weeknight_chef');
    fixture.detectChanges();

    expect(loadedSpy).toHaveBeenCalledTimes(1);
  });

  it('missing-skill (ok:false) renders the explanation + a Reinstall CTA per missing skill, and does NOT emit `loaded`', async () => {
    await init();
    ipc.when('template_load', () => ({
      ok: false,
      skill_ids: [],
      ui_overrides: null,
      missing_skills: ['nutrition-coach'],
    }));
    const loadedSpy = jasmine.createSpy('loaded');
    component.loaded.subscribe(loadedSpy);

    await component.onLoad('tmpl_weeknight_chef');
    fixture.detectChanges();

    expect(loadedSpy).not.toHaveBeenCalled();
    const el = fixture.nativeElement as HTMLElement;
    const alert = el.querySelector('[role="alert"]');
    expect(alert).withContext('a role=alert explanation must render').toBeTruthy();
    expect(alert!.textContent).toContain('nutrition-coach');
    const reinstallBtn = el.querySelector<HTMLButtonElement>('.reinstall-btn');
    expect(reinstallBtn).withContext('a Reinstall button must render for the missing skill').toBeTruthy();
    expect(reinstallBtn!.textContent).toContain('nutrition-coach');
  });

  it('clicking Reinstall calls PurchaseService.install(id, true)', async () => {
    await init();
    ipc.when('template_load', () => ({ ok: false, skill_ids: [], ui_overrides: null, missing_skills: ['nutrition-coach'] }));
    await component.onLoad('tmpl_weeknight_chef');
    fixture.detectChanges();

    const purchase = TestBed.inject(PurchaseService);
    const installSpy = spyOn(purchase, 'install').and.resolveTo();

    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('.reinstall-btn')!.click();
    fixture.detectChanges();

    expect(installSpy).toHaveBeenCalledWith('nutrition-coach', true);
  });

  it('ok:true with unresolved skills still emits `loaded` and renders an inline note (not an alert)', async () => {
    await init();
    ipc.when('template_load', () => ({
      ok: true,
      skill_ids: ['kitchen-timer', 'future-marketplace-skill'],
      ui_overrides: [],
      missing_skills: [],
    }));
    const loadedSpy = jasmine.createSpy('loaded');
    component.loaded.subscribe(loadedSpy);

    await component.onLoad('tmpl_weeknight_chef');
    fixture.detectChanges();

    expect(loadedSpy).toHaveBeenCalledTimes(1);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[role="alert"]')).toBeFalsy();
    expect(el.textContent).toContain('future-marketplace-skill');
    expect(el.textContent).toContain("can't be auto-enabled yet");
  });
});
