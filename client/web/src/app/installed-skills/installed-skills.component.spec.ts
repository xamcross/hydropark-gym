import { TestBed } from '@angular/core/testing';
import { InstalledSkillsComponent } from './installed-skills.component';
import { EnabledSkillsService } from '../composition/enabled-skills.service';
import { IPC_PORT, IpcPort, Unlisten } from '../ipc/ipc.port';
import { InstalledSkillView, IpcCommand, IpcCommandMap, IpcEvent } from '../ipc/contract';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = (args: any) => any;

class ScriptedIpc extends IpcPort {
  private readonly handlers = new Map<IpcCommand, AnyHandler>();

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

const PACKING_LIST: InstalledSkillView = { skill_id: 'packing-list', name: 'Packing List', version: '1.0.0', enabled: false };
const KITCHEN_TIMER_ROW: InstalledSkillView = { skill_id: 'kitchen-timer', name: 'Kitchen Timer & Units', version: '1.0.0', enabled: false };

describe('InstalledSkillsComponent (W06 gap fix)', () => {
  let ipc: ScriptedIpc;
  let fixture: ReturnType<typeof TestBed.createComponent<InstalledSkillsComponent>>;
  let component: InstalledSkillsComponent;

  async function init(): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  beforeEach(() => {
    ipc = new ScriptedIpc();
    ipc.when('skills_list_installed', () => []);
    TestBed.configureTestingModule({
      imports: [InstalledSkillsComponent],
      providers: [{ provide: IPC_PORT, useValue: ipc }],
    });
    fixture = TestBed.createComponent(InstalledSkillsComponent);
    component = fixture.componentInstance;
  });

  it('renders nothing when no skill is installed', async () => {
    await init();
    expect(component.skills()).toEqual([]);
    expect((fixture.nativeElement as HTMLElement).querySelector('.installed-skills')).toBeFalsy();
  });

  it('lists a just-installed free skill (e.g. Packing List) that was previously invisible', async () => {
    ipc.when('skills_list_installed', () => [PACKING_LIST]);
    await init();

    expect(component.skills()).toEqual([PACKING_LIST]);
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Packing List');
  });

  it('filters out the two hardcoded P0 skills defensively (never a duplicate toggle)', async () => {
    ipc.when('skills_list_installed', () => [KITCHEN_TIMER_ROW, PACKING_LIST]);
    await init();

    const ids = component.skills().map((s) => s.skill_id);
    expect(ids).toEqual(['packing-list']);
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).not.toContain('Kitchen Timer');
  });

  it('a fresh install starts NOT enabled — the switch renders off', async () => {
    ipc.when('skills_list_installed', () => [PACKING_LIST]);
    await init();

    const el = fixture.nativeElement as HTMLElement;
    const sw = el.querySelector<HTMLButtonElement>('button.switch')!;
    expect(sw).withContext('a toggle switch must render for an installed skill').toBeTruthy();
    expect(sw.classList.contains('on')).toBe(false);
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });

  it('clicking the toggle enables the skill via EnabledSkillsService — the working enable/disable seam', async () => {
    ipc.when('skills_list_installed', () => [PACKING_LIST]);
    await init();

    const enabledSkills = TestBed.inject(EnabledSkillsService);
    expect(enabledSkills.has('packing-list')).toBe(false);

    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('button.switch')!.click();
    fixture.detectChanges();

    expect(enabledSkills.has('packing-list')).toBe(true);
    const sw = el.querySelector<HTMLButtonElement>('button.switch')!;
    expect(sw.classList.contains('on')).toBe(true);
    expect(sw.getAttribute('aria-checked')).toBe('true');
  });

  it('clicking the toggle again disables it', async () => {
    ipc.when('skills_list_installed', () => [PACKING_LIST]);
    await init();

    const enabledSkills = TestBed.inject(EnabledSkillsService);
    const el = fixture.nativeElement as HTMLElement;
    const sw = el.querySelector<HTMLButtonElement>('button.switch')!;

    sw.click();
    fixture.detectChanges();
    expect(enabledSkills.has('packing-list')).toBe(true);

    sw.click();
    fixture.detectChanges();
    expect(enabledSkills.has('packing-list')).toBe(false);
    expect(sw.classList.contains('on')).toBe(false);
  });

  it('refresh() re-pulls the registry — a second install appears without a full remount', async () => {
    ipc.when('skills_list_installed', () => []);
    await init();
    expect(component.skills()).toEqual([]);

    ipc.when('skills_list_installed', () => [PACKING_LIST]);
    await component.refresh();
    fixture.detectChanges();

    expect(component.skills()).toEqual([PACKING_LIST]);
  });
});
