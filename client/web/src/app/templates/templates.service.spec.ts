import { TestBed } from '@angular/core/testing';
import { TemplatesService, TEMPLATE_BASE_MODEL } from './templates.service';
import { CompositionService } from '../composition/composition.service';
import { LayoutSnapshotService } from '../shared/layout/layout-snapshot.service';
import { SessionService } from '../state/session.service';
import { CookingAssistantService } from '../skills/cooking-assistant/cooking-assistant.service';
import { UnlockService } from '../unlock/unlock.service';
import { IPC_PORT, IpcPort, Unlisten } from '../ipc/ipc.port';
import { ComposedAgentView, IpcCommand, IpcCommandMap, IpcEvent } from '../ipc/contract';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = (args: any) => any;

/** `UnlockService`'s persisted-unlock localStorage key (mirrors telemetry.service.spec.ts's
 * own `PRIOR_SESSION_KEY` isolation pattern) — a real Storage the browser test runner keeps
 * across `TestBed` resets, so a prior test's `devSimulateUnlock()` would otherwise leak the
 * "cooking-assistant is unlocked" state into every test after it (Jasmine's default test
 * order is randomized, so this bites nondeterministically without the clear below). */
const UNLOCK_STORAGE_KEY = 'hydropark.phase0.unlock.v1';

const STUB_COMPOSED: ComposedAgentView = {
  order: [],
  primary: null,
  persona: '',
  tools: [],
  routing: [],
  capacity: { ctx_window: 4096, reserve_tokens: 0, skill_tokens: 0, used_tokens: 0, remaining: 4096, blocked: false, overflow: 0 },
};

/** Records every invoked command (in call order); per-command handlers via `.when()`. */
class ScriptedIpc extends IpcPort {
  readonly calls: { cmd: IpcCommand; args: unknown }[] = [];
  private readonly handlers = new Map<IpcCommand, AnyHandler>();

  constructor() {
    super();
    // CompositionService recomposes on every enabled-set change; give it something
    // harmless to resolve so it never pollutes/rejects noisily during these tests.
    this.handlers.set('compose_agent', () => STUB_COMPOSED);
    this.handlers.set('skill_enable', (args: IpcCommandMap['skill_enable']['args']) => ({
      skill_id: args.skill_id,
      persona_injected: true,
      tools_registered: [],
      panels: [],
    }));
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

describe('TemplatesService (Task 11b)', () => {
  let ipc: ScriptedIpc;
  let templates: TemplatesService;
  let session: SessionService;
  let cooking: CookingAssistantService;
  let composition: CompositionService;
  let layoutSnapshot: LayoutSnapshotService;

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
    templates = TestBed.inject(TemplatesService);
    session = TestBed.inject(SessionService);
    cooking = TestBed.inject(CookingAssistantService);
    composition = TestBed.inject(CompositionService);
    layoutSnapshot = TestBed.inject(LayoutSnapshotService);
  });

  // --- save → list round trip -----------------------------------------------

  it('save() posts the enabled manifests as [id, version] pairs, the fixed base model, and the live layout snapshot; refresh() then lists it', async () => {
    session.kitchenSkillEnabled.set(true); // enables the free kitchen-timer manifest
    const fakeOverrides = [{ key: 'timer_stack timers ', collapsed: true, pinned: false, order: null, size: null }];
    spyOn(layoutSnapshot, 'snapshot').and.returnValue(fakeOverrides);
    ipc.when('template_save', (args) => ({
      id: 'tmpl_weeknight_chef',
      name: args.name,
      skill_refs: args.skill_refs.map(([id]) => id),
      base_model: args.base_model,
    }));
    ipc.when('template_list', () => [
      { id: 'tmpl_weeknight_chef', name: 'Weeknight Chef', skill_refs: ['kitchen-timer'], base_model: TEMPLATE_BASE_MODEL },
    ]);

    const view = await templates.save('Weeknight Chef');

    const saveCall = ipc.calls.find((c) => c.cmd === 'template_save')!;
    expect(saveCall.args).toEqual({
      name: 'Weeknight Chef',
      skill_refs: [['kitchen-timer', '1.0.0']],
      base_model: TEMPLATE_BASE_MODEL,
      ui_overrides: fakeOverrides,
    });
    expect(view.id).toBe('tmpl_weeknight_chef');

    // refresh() ran automatically — the gallery signal reflects the saved template.
    expect(ipc.calls.map((c) => c.cmd)).toContain('template_list');
    expect(templates.templates().map((t) => t.name)).toEqual(['Weeknight Chef']);
  });

  it('save() rejects an empty/whitespace-only name and never calls template_save', async () => {
    await expectAsync(templates.save('   ')).toBeRejectedWithError('Template name is required.');
    expect(ipc.calls.map((c) => c.cmd)).not.toContain('template_save');
  });

  // --- load: ok:false → missing skills, no state mutated --------------------

  it('load() with ok:false surfaces missingSkills verbatim and does not touch enablement or viaTemplate', async () => {
    ipc.when('template_load', () => ({
      ok: false,
      skill_ids: [],
      ui_overrides: null,
      missing_skills: ['nutrition-coach'],
    }));

    const outcome = await templates.load('tmpl_x');

    expect(outcome).toEqual({ ok: false, missingSkills: ['nutrition-coach'] });
    expect(session.kitchenSkillEnabled()).toBe(false);
    expect(composition.viaTemplate()).toBe(false);
  });

  // --- load: ok:true → enable combo, restore layout, mark viaTemplate -------

  it('load() with ok:true enables the named skills, restores the layout via LayoutSnapshotService, and sets viaTemplate', async () => {
    const restoreSpy = jasmine.createSpy('restore');
    layoutSnapshot.register({ capture: () => [], restore: restoreSpy });
    const overrides = [{ key: 'x', collapsed: true, pinned: false, order: null, size: null }];
    ipc.when('template_load', () => ({
      ok: true,
      skill_ids: ['kitchen-timer'],
      ui_overrides: overrides,
      missing_skills: [],
    }));

    const outcome = await templates.load('tmpl_weeknight_chef');

    expect(outcome).toEqual({ ok: true, unresolved: [] });
    expect(session.kitchenSkillEnabled()).toBe(true);
    expect(restoreSpy).toHaveBeenCalledWith(overrides);
    expect(composition.viaTemplate()).toBe(true);
  });

  it('load() disables a currently-enabled skill the template does NOT name (exact-combo restore, the B2 "disable all -> load" beat)', async () => {
    session.kitchenSkillEnabled.set(true);
    ipc.when('template_load', () => ({ ok: true, skill_ids: [], ui_overrides: [], missing_skills: [] }));

    await templates.load('tmpl_empty');

    expect(session.kitchenSkillEnabled()).toBe(false);
  });

  it('load() reports a skill id outside the current enablement seam as unresolved (not missing, not thrown)', async () => {
    ipc.when('template_load', () => ({
      ok: true,
      skill_ids: ['kitchen-timer', 'future-marketplace-skill'],
      ui_overrides: [],
      missing_skills: [],
    }));

    const outcome = await templates.load('tmpl_future');

    expect(outcome).toEqual({ ok: true, unresolved: ['future-marketplace-skill'] });
    expect(session.kitchenSkillEnabled()).toBe(true);
  });

  it('load() reports a still-locked paid skill (cooking-assistant) as unresolved rather than silently skipping it', async () => {
    ipc.when('template_load', () => ({ ok: true, skill_ids: ['cooking-assistant'], ui_overrides: [], missing_skills: [] }));

    const outcome = await templates.load('tmpl_paid');

    expect(outcome).toEqual({ ok: true, unresolved: ['cooking-assistant'] });
    expect(cooking.enabled()).toBe(false);
  });

  it('load() enables an already-unlocked paid skill cleanly (no unresolved entry)', async () => {
    const unlock = TestBed.inject(UnlockService);
    await unlock.devSimulateUnlock();
    ipc.when('template_load', () => ({ ok: true, skill_ids: ['cooking-assistant'], ui_overrides: [], missing_skills: [] }));

    const outcome = await templates.load('tmpl_paid_unlocked');

    expect(outcome).toEqual({ ok: true, unresolved: [] });
    expect(cooking.enabled()).toBe(true);
  });
});
