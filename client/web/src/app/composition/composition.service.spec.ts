import { TestBed } from '@angular/core/testing';
import { CompositionService } from './composition.service';
import { EnabledSkillsService } from './enabled-skills.service';
import { SessionService } from '../state/session.service';
import { CookingAssistantService } from '../skills/cooking-assistant/cooking-assistant.service';
import { IPC_PORT, IpcPort, Unlisten } from '../ipc/ipc.port';
import { IpcCommand, IpcCommandMap, IpcEvent } from '../ipc/contract';
import { KITCHEN_TIMER_MANIFEST, COOKING_ASSISTANT_MANIFEST, NUTRITION_COACH_MANIFEST } from './manifest-registry';

/** No-op `IpcPort`: resolves every command with `undefined` and never pushes events.
 *  Mirrors `composed-panel-host.component.spec.ts`'s harness — `compose_agent`'s
 *  actual (async) result is irrelevant to these tests, which assert the
 *  synchronous `enabledManifests`/`enabledIds`/`slots` derivations only. */
class NoopIpc extends IpcPort {
  invoke<K extends IpcCommand>(_cmd: K, _args: IpcCommandMap[K]['args']): Promise<IpcCommandMap[K]['result']> {
    return Promise.resolve(undefined as IpcCommandMap[K]['result']);
  }

  on<K extends IpcEvent>(): Unlisten {
    return () => undefined;
  }
}

describe('CompositionService — enablement union (Task 14, F03/F07)', () => {
  let composition: CompositionService;
  let enabledSkills: EnabledSkillsService;
  let session: SessionService;
  let cooking: CookingAssistantService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [{ provide: IPC_PORT, useValue: new NoopIpc() }],
    });
    composition = TestBed.inject(CompositionService);
    enabledSkills = TestBed.inject(EnabledSkillsService);
    session = TestBed.inject(SessionService);
    cooking = TestBed.inject(CookingAssistantService);
  });

  it('composes nothing when no P0 signal is set and the store is empty', () => {
    expect(composition.enabledManifests()).toEqual([]);
    expect(composition.enabledIds()).toEqual([]);
  });

  it('the P0 kitchen-timer signal still works exactly as before', () => {
    session.kitchenSkillEnabled.set(true);

    expect(composition.enabledManifests()).toEqual([KITCHEN_TIMER_MANIFEST]);
    expect(composition.enabledIds()).toEqual(['kitchen-timer']);
  });

  it('the P0 cooking-assistant signal still works exactly as before', () => {
    cooking.enabled.set(true);

    expect(composition.enabledManifests()).toEqual([COOKING_ASSISTANT_MANIFEST]);
  });

  it('enabling a non-P0 skill via the store adds its manifest to enabledManifests', () => {
    enabledSkills.enable('nutrition-coach');

    expect(composition.enabledManifests()).toEqual([NUTRITION_COACH_MANIFEST]);
    expect(composition.enabledIds()).toEqual(['nutrition-coach']);
  });

  it('disabling a store-driven skill removes it from enabledManifests', () => {
    enabledSkills.enable('nutrition-coach');
    expect(composition.enabledManifests().length).toBe(1);

    enabledSkills.disable('nutrition-coach');

    expect(composition.enabledManifests()).toEqual([]);
    expect(composition.enabledIds()).toEqual([]);
  });

  it('unions P0 signals with the store, deduped, P0 skills first', () => {
    session.kitchenSkillEnabled.set(true);
    cooking.enabled.set(true);
    enabledSkills.enable('nutrition-coach');
    enabledSkills.enable('packing-list');

    expect(composition.enabledIds()).toEqual([
      'kitchen-timer',
      'cooking-assistant',
      'nutrition-coach',
      'packing-list',
    ]);
  });

  it('a store id the dev registry does not know about is silently skipped, not thrown', () => {
    enabledSkills.enable('some-unknown-skill');
    session.kitchenSkillEnabled.set(true);

    expect(() => composition.enabledManifests()).not.toThrow();
    expect(composition.enabledIds()).toEqual(['kitchen-timer']);
  });

  it(
    'B2 slot fidelity: composing kitchen-timer + nutrition-coach registers a single ' +
      "'ingredients' slot with kitchen-timer as writer-of-record (single-writer rule preserved)",
    () => {
      session.kitchenSkillEnabled.set(true);
      enabledSkills.enable('nutrition-coach');

      const slots = composition.slots();
      const ingredients = slots.find((s) => s.slot === 'ingredients');
      expect(ingredients).withContext('ingredients slot should be registered').toBeTruthy();
      expect(ingredients?.writerOfRecord).toBe('kitchen-timer');
      expect(ingredients?.access).toBe('read_write');

      // nutrition-coach's OWN food_log slot is unaffected — it remains that
      // skill's writer-of-record.
      const foodLog = slots.find((s) => s.slot === 'food_log');
      expect(foodLog?.writerOfRecord).toBe('nutrition-coach');
    }
  );

  it("nutrition-coach's macros panel is bound to the shared 'ingredients' slot", () => {
    enabledSkills.enable('nutrition-coach');

    const panels = composition.panels();
    const targets = panels.find((p) => p.id === 'targets');
    expect(targets?.binding).toBe('ingredients');
    expect(targets?.ownerSkillId).toBe('nutrition-coach');
  });
});
