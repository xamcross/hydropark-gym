import { TestBed } from '@angular/core/testing';
import { EnabledSkillsService } from './enabled-skills.service';

describe('EnabledSkillsService (Task 14 — composition enablement store)', () => {
  let store: EnabledSkillsService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    store = TestBed.inject(EnabledSkillsService);
  });

  it('starts with no skill enabled', () => {
    expect(store.enabledIds()).toEqual([]);
    expect(store.has('nutrition-coach')).toBe(false);
    expect(store.isEnabled('nutrition-coach')()).toBe(false);
  });

  it('enable(id) adds the id — has()/isEnabled()/enabledIds() all agree', () => {
    store.enable('nutrition-coach');

    expect(store.has('nutrition-coach')).toBe(true);
    expect(store.isEnabled('nutrition-coach')()).toBe(true);
    expect(store.enabledIds()).toEqual(['nutrition-coach']);
  });

  it('enable(id) is idempotent — enabling twice does not duplicate the id', () => {
    store.enable('packing-list');
    store.enable('packing-list');

    expect(store.enabledIds()).toEqual(['packing-list']);
  });

  it('disable(id) removes the id', () => {
    store.enable('travel-planner');
    store.disable('travel-planner');

    expect(store.has('travel-planner')).toBe(false);
    expect(store.isEnabled('travel-planner')()).toBe(false);
    expect(store.enabledIds()).toEqual([]);
  });

  it('disable(id) on an id that was never enabled is a harmless no-op', () => {
    store.disable('never-enabled');

    expect(store.enabledIds()).toEqual([]);
  });

  it('toggle(id) flips enabled -> disabled -> enabled', () => {
    expect(store.has('nutrition-coach')).toBe(false);

    store.toggle('nutrition-coach');
    expect(store.has('nutrition-coach')).toBe(true);

    store.toggle('nutrition-coach');
    expect(store.has('nutrition-coach')).toBe(false);

    store.toggle('nutrition-coach');
    expect(store.has('nutrition-coach')).toBe(true);
  });

  it('tracks multiple ids independently', () => {
    store.enable('nutrition-coach');
    store.enable('packing-list');

    expect(new Set(store.enabledIds())).toEqual(new Set(['nutrition-coach', 'packing-list']));
    expect(store.has('travel-planner')).toBe(false);

    store.disable('nutrition-coach');

    expect(new Set(store.enabledIds())).toEqual(new Set(['packing-list']));
  });

  it('isEnabled(id) returns a live signal that reflects later enable/disable calls', () => {
    const sig = store.isEnabled('travel-planner');
    expect(sig()).toBe(false);

    store.enable('travel-planner');
    expect(sig()).toBe(true);

    store.disable('travel-planner');
    expect(sig()).toBe(false);
  });
});
