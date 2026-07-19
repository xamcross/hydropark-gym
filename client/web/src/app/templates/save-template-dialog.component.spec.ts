import { TestBed } from '@angular/core/testing';
import { SaveTemplateDialogComponent } from './save-template-dialog.component';
import { TemplatesService } from './templates.service';
import { SessionService } from '../state/session.service';
import { IPC_PORT, IpcPort, Unlisten } from '../ipc/ipc.port';
import { ComposedAgentView, IpcCommand, IpcCommandMap, IpcEvent } from '../ipc/contract';

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

class ScriptedIpc extends IpcPort {
  readonly calls: { cmd: IpcCommand; args: unknown }[] = [];
  private readonly handlers = new Map<IpcCommand, AnyHandler>();

  constructor() {
    super();
    this.handlers.set('compose_agent', () => STUB_COMPOSED);
  }

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

describe('SaveTemplateDialogComponent (Task 11b)', () => {
  let ipc: ScriptedIpc;
  let fixture: ReturnType<typeof TestBed.createComponent<SaveTemplateDialogComponent>>;
  let component: SaveTemplateDialogComponent;

  beforeEach(() => {
    ipc = new ScriptedIpc();
    TestBed.configureTestingModule({
      imports: [SaveTemplateDialogComponent],
      providers: [{ provide: IPC_PORT, useValue: ipc }],
    });
    fixture = TestBed.createComponent(SaveTemplateDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('renders the dialog with role="dialog" and a name input', () => {
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[role="dialog"]')).toBeTruthy();
    expect(el.querySelector('.save-tmpl-name')).toBeTruthy();
  });

  it('blocks submit on an empty name: no template_save call, an error is shown, saved is not emitted', async () => {
    const savedSpy = jasmine.createSpy('saved');
    component.saved.subscribe(savedSpy);

    await component.onSubmit();
    fixture.detectChanges();

    expect(ipc.calls.map((c) => c.cmd)).not.toContain('template_save');
    expect(savedSpy).not.toHaveBeenCalled();
    expect(component.errorMsg()).toBeTruthy();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('name');
  });

  it('blocks submit on a whitespace-only name the same way', async () => {
    component.name.set('   ');

    await component.onSubmit();

    expect(ipc.calls.map((c) => c.cmd)).not.toContain('template_save');
    expect(component.errorMsg()).toBeTruthy();
  });

  it('a non-empty name calls TemplatesService.save and emits `saved` with the result', async () => {
    const templatesSvc = TestBed.inject(TemplatesService);
    const view = { id: 'tmpl_x', name: 'Weeknight Chef', skill_refs: [], base_model: 'qwen2.5-3b-instruct-q4_k_m' };
    const saveSpy = spyOn(templatesSvc, 'save').and.resolveTo(view);
    const savedSpy = jasmine.createSpy('saved');
    component.saved.subscribe(savedSpy);
    component.name.set('Weeknight Chef');

    await component.onSubmit();

    expect(saveSpy).toHaveBeenCalledWith('Weeknight Chef');
    expect(savedSpy).toHaveBeenCalledWith(view);
    expect(component.errorMsg()).toBeNull();
  });

  it('Escape emits cancel with no IPC call', () => {
    const cancelSpy = jasmine.createSpy('cancel');
    component.cancel.subscribe(cancelSpy);

    component.onEscape();

    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(ipc.calls.map((c) => c.cmd)).not.toContain('template_save');
  });

  it('shows the currently-enabled skills as chips, previewing what will be saved', () => {
    const session = TestBed.inject(SessionService);
    session.kitchenSkillEnabled.set(true);
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Kitchen Timer & Units');
  });
});
