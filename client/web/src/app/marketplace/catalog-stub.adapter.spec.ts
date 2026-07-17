import { StubCatalogPort } from './catalog-stub.adapter';
import { SAMPLE_PROMPTS } from './sample-prompts';

/**
 * Task 17 (phase 2): the curated real-model preview transcripts
 * (`preview-transcripts.ts`, sourced from `client/src-tauri/previews/*.json`)
 * must reach `StubCatalogPort.getPreview()` — the seam `SkillPreviewComponent`
 * actually calls (`skill-preview.component.ts#load`) — and must never leak a
 * raw tool-call wire fragment into buyer-facing transcript text. That's the
 * curation guarantee this spec locks: every curated `{"name":...}`-shaped
 * fragment the real capture produced (kitchen-timer's `start_timer` call,
 * packing-list's `set_all` line, etc.) must have been re-rendered as prose
 * before it ever reaches the preview modal.
 */
describe('StubCatalogPort#getPreview — curated real-model transcripts (Task 17)', () => {
  let port: StubCatalogPort;

  beforeEach(() => {
    port = new StubCatalogPort();
  });

  it('kitchen-timer: returns a non-empty, no_purchase transcript with no raw tool-call fragment', async () => {
    const preview = await port.getPreview('kitchen-timer');

    expect(preview.skill_id).toBe('kitchen-timer');
    expect(preview.name).toBe('Kitchen Timer & Units');
    expect(preview.no_purchase).toBe(true);
    expect(preview.capped).toBe(true);
    expect(preview.transcript.length).toBeGreaterThan(0);
    for (const line of preview.transcript) {
      expect(line.text).not.toContain('{"name":');
      expect(line.text).not.toContain('<tool_call>');
    }
    // The specific fragment the real capture leaked (a leading `>` plus the raw
    // start_timer JSON) must have become natural, app-rendered text.
    const assistantLines = preview.transcript.filter((l) => l.role === 'assistant').map((l) => l.text);
    expect(assistantLines.some((t) => /9:00/.test(t) && /Cook pasta/.test(t))).toBe(true);
  });

  it('kitchen-timer: never shows the paid Cooking Assistant substitutions capability (SPEC §11.2 fix)', async () => {
    const preview = await port.getPreview('kitchen-timer');
    const allText = preview.transcript.map((l) => l.text).join(' | ');
    expect(allText).not.toContain('buttermilk');
    expect(preview.transcript.length).toBe(5); // system banner + 2 in-scope exchanges (2 msgs each)
  });

  it('packing-list: returns a non-empty, no_purchase transcript with no raw tool-call fragment', async () => {
    const preview = await port.getPreview('packing-list');

    expect(preview.skill_id).toBe('packing-list');
    expect(preview.no_purchase).toBe(true);
    expect(preview.transcript.length).toBeGreaterThan(0);
    for (const line of preview.transcript) {
      expect(line.text).not.toContain('{"name":');
      expect(line.text).not.toMatch(/set_all:\s*\[op=/);
    }
  });

  it('packing-list: never shows the paid Travel Planner visa/border-ruling capability (SPEC §11.2 fix)', async () => {
    const preview = await port.getPreview('packing-list');
    const allText = preview.transcript.map((l) => l.text).join(' | ');
    expect(allText.toLowerCase()).not.toContain('visa');
    expect(allText).not.toContain('Japan');
    expect(preview.transcript.length).toBe(5); // system banner + 2 in-scope exchanges (2 msgs each)
  });

  it('cooking-assistant: returns a non-empty, no_purchase transcript with no raw tool-call fragment', async () => {
    const preview = await port.getPreview('cooking-assistant');

    expect(preview.skill_id).toBe('cooking-assistant');
    expect(preview.no_purchase).toBe(true);
    expect(preview.transcript.length).toBeGreaterThan(0);
    for (const line of preview.transcript) {
      expect(line.text).not.toContain('{"name":');
      expect(line.text).not.toContain('[list_manage');
    }
  });

  it('every curated skill preview is non-empty, capped, and free of raw tool-call/wire fragments', async () => {
    const curatedIds = [
      'kitchen-timer',
      'packing-list',
      'cooking-assistant',
      'nutrition-coach',
      'home-diy',
      'garden-plants',
      'car-care',
      'budget-bills',
      'study-flashcards',
      'travel-planner',
    ];

    for (const id of curatedIds) {
      const preview = await port.getPreview(id);
      expect(preview.skill_id).toBe(id);
      expect(preview.no_purchase).toBe(true);
      expect(preview.capped).toBe(true);
      expect(preview.transcript.length).toBeGreaterThan(0);
      expect(preview.name).toBeTruthy();
      for (const line of preview.transcript) {
        expect(line.text).not.toContain('{"name":');
        expect(line.text).not.toContain('<tool_call>');
        expect(line.text.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('a skill with no curated transcript still falls back to the synthetic buildPreview() path', async () => {
    // budget-planner has no captured transcript (not in preview-transcripts.ts)
    // but IS a StubCatalogPort record with has_preview: true — the pre-existing
    // synthetic path must still work, unaffected by the curated-preview seam.
    const preview = await port.getPreview('budget-planner');
    expect(preview.skill_id).toBe('budget-planner');
    expect(preview.no_purchase).toBe(true);
    expect(preview.transcript.length).toBeGreaterThan(0);
  });
});

/**
 * Task 18: `getDetail()` sample prompts + screenshots. The "Try asking"
 * section (SPEC §11.1) must show the real captured user turns for the 2
 * skills the demo grid can reach that also have a capture (kitchen-timer,
 * cooking-assistant) — winning over the record's own hand-authored
 * placeholder prompts, mirroring the `getPreview()` curated-first pattern
 * above. `budget-planner`/`code-reviewer` have no capture, so must be
 * completely unaffected (regression guard). Separately, `sample-prompts.ts`
 * itself must carry 2-3 authored prompts for ALL 10 manifest-certified
 * skills, not just the 2 that happen to be reachable today (Task 17's own
 * "7 skills, no catalog card yet" gap — tracked, not fixed, here either).
 */
describe('StubCatalogPort#getDetail — curated sample prompts & screenshots (Task 18)', () => {
  let port: StubCatalogPort;

  beforeEach(() => {
    port = new StubCatalogPort();
  });

  it('kitchen-timer: sample_prompts are the real captured user turns, and never leak the paid Cooking Assistant substitutions capability (SPEC §11.2)', async () => {
    const detail = await port.getDetail('kitchen-timer');
    // Only 2: the captured buttermilk-substitution turn was dropped from
    // preview-transcripts.ts — kitchen-timer is FREE and its own manifest marks
    // substitutions out of scope, redirecting to the PAID Cooking Assistant.
    expect(detail.sample_prompts).toEqual(['Set a 9 minute timer for the pasta.', "What's 350F in Celsius?"]);
    expect(detail.sample_prompts).not.toContain('What can I use instead of buttermilk?');
  });

  it('packing-list: sample_prompts are the real captured user turns, and never leak the paid Travel Planner visa/border-ruling capability (SPEC §11.2)', async () => {
    const detail = await port.getDetail('packing-list');
    // Only 2: the captured Japan-visa turn was dropped from preview-transcripts.ts
    // — packing-list is FREE and its own manifest marks visa/border rulings out
    // of scope, redirecting to the PAID Travel Planner.
    expect(detail.sample_prompts).toEqual([
      'Beach weekend, 2 nights — start my list.',
      'I leave on 2026-05-03 for 5 nights — when do I come back?',
    ]);
    expect(detail.sample_prompts).not.toContain('Do I need a visa for Japan?');
  });

  it('cooking-assistant: sample_prompts are the real captured user turns', async () => {
    const detail = await port.getDetail('cooking-assistant');
    expect(detail.sample_prompts).toEqual([
      'Quick tomato pasta for two, please.',
      'Start a 12 minute timer for the sauce.',
      'Is this keto meal okay for my diabetes?',
    ]);
  });

  it('kitchen-timer and cooking-assistant each carry at least one real (non-placeholder) screenshot', async () => {
    const kt = await port.getDetail('kitchen-timer');
    const ca = await port.getDetail('cooking-assistant');
    expect(kt.media?.some((m) => !!m.uri)).toBe(true);
    expect(ca.media?.some((m) => !!m.uri)).toBe(true);
    // The gap (populated/composed-panel screenshots need the native app) is
    // flagged via a placeholder tile, never faked with a fabricated uri.
    expect(kt.media?.some((m) => !m.uri)).toBe(true);
    expect(ca.media?.some((m) => !m.uri)).toBe(true);
  });

  it('budget-planner (no capture) keeps its original placeholder sample_prompts and media untouched', async () => {
    const detail = await port.getDetail('budget-planner');
    expect(detail.sample_prompts).toEqual([
      'Budget $3,200/month',
      'Add groceries at $600',
      'How much is left this month?',
    ]);
    expect(detail.media?.every((m) => !m.uri)).toBe(true);
  });

  it('code-reviewer (no capture) keeps its original placeholder sample_prompts, unaffected by the curated lookup', async () => {
    const detail = await port.getDetail('code-reviewer');
    expect(detail.sample_prompts).toEqual(['Review this diff', 'Any correctness bugs?', 'Suggest a simpler version']);
  });

  it('every one of the 10 manifest-certified skills has 2-3 non-empty authored sample prompts', () => {
    const ids = [
      'kitchen-timer',
      'packing-list',
      'cooking-assistant',
      'nutrition-coach',
      'home-diy',
      'garden-plants',
      'car-care',
      'budget-bills',
      'study-flashcards',
      'travel-planner',
    ];
    for (const id of ids) {
      const prompts = SAMPLE_PROMPTS[id];
      expect(prompts).withContext(id).toBeTruthy();
      expect(prompts.length).withContext(`${id} prompt count`).toBeGreaterThanOrEqual(2);
      expect(prompts.length).withContext(`${id} prompt count`).toBeLessThanOrEqual(3);
      for (const p of prompts) {
        expect(p.trim().length).withContext(`${id}: "${p}"`).toBeGreaterThan(0);
      }
    }
  });
});
