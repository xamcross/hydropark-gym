import { TOUR_STEPS, MAGIC_PROMPT, TourAnchorId } from './tour.model';

describe('tour.model', () => {
  it('defines exactly six steps in the documented order', () => {
    const ids = TOUR_STEPS.map((s) => s.id);
    expect(ids).toEqual(['chat', 'panels', 'speed', 'marketplace', 'templates', 'account'] as TourAnchorId[]);
  });

  it('has exactly one hands-on magic step, and it is the first', () => {
    const magic = TOUR_STEPS.filter((s) => s.advance === 'magic');
    expect(magic.length).toBe(1);
    expect(TOUR_STEPS[0].advance).toBe('magic');
  });

  it('gives every step non-empty title and body copy', () => {
    for (const s of TOUR_STEPS) {
      expect(s.title.trim().length).toBeGreaterThan(0);
      expect(s.body.trim().length).toBeGreaterThan(0);
    }
  });

  it('uses the exact carbonara magic prompt (mock/demo/E2E depend on it)', () => {
    expect(MAGIC_PROMPT).toBe('Help me cook carbonara for 4');
  });
});
