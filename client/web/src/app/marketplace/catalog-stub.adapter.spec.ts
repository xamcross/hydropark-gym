import { StubCatalogPort } from './catalog-stub.adapter';

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
