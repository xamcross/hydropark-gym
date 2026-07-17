/**
 * Hydropark Task 18 — curated sample prompts for the skill detail page's
 * "Try asking" section (SPEC §11.1 `SkillDetail.sample_prompts`).
 *
 * SOURCE: the same real captured `role:"user"` lines Task 17 already curated
 * into `preview-transcripts.ts`'s `CURATED_PREVIEWS` from
 * `client/src-tauri/previews/*.json` (real Qwen2.5-3B output for each skill's
 * certified `contracts/catalog/<id>.manifest.json` persona). Every one of
 * those user turns drove a real, good response from the actual on-device
 * engine — proven-realistic examples of what the skill does, not invented
 * marketing copy. Reused VERBATIM here (not reworded) so there is one
 * evidence trail for "what does this skill actually do", not two
 * independently-authored ones that could quietly drift apart.
 *
 * Deliberately includes each skill's boundary/decline turn where the capture
 * has one (e.g. cooking-assistant's diabetes question, car-care's brake
 * question) — that is also real, honest behaviour: it shows a shopper the
 * skill's actual scope limit rather than only ever showing the happy path.
 * Nothing here implies a capability the skill's certified persona doesn't
 * have (SPEC/task honesty constraint) — every prompt is one the skill was
 * actually, certifiably asked and actually, certifiably answered.
 *
 * Covers all 10 manifest-certified skills (`contracts/catalog/*.manifest.json`).
 * Only 3 of the 10 — kitchen-timer, packing-list, cooking-assistant — are
 * reachable from the `ng serve` marketplace grid today (`StubCatalogPort`'s
 * own 5 records); the other 7 have no `CatalogItem`/`SkillDetail` stub record
 * yet (a gap Task 17 already flagged and explicitly left open — adding 7 more
 * full catalog listings, with invented pricing/size/icon content, is a
 * separate task). This constant still carries all 10 so that gap can be
 * closed later by wiring, not re-authoring.
 */

import { CURATED_PREVIEWS } from './preview-transcripts';

function userTurns(skillId: string): string[] {
  const curated = CURATED_PREVIEWS[skillId];
  if (!curated) return [];
  return curated.messages.filter((m) => m.role === 'user').map((m) => m.text);
}

/**
 * Skill id -> 2-3 sample prompts, sourced from the real captured+curated
 * transcripts above. Derived once (not hand-duplicated) from
 * {@link CURATED_PREVIEWS} so the two stay in lockstep by construction.
 */
export const SAMPLE_PROMPTS: Readonly<Record<string, string[]>> = Object.freeze(
  Object.fromEntries(Object.keys(CURATED_PREVIEWS).map((id) => [id, userTurns(id)]))
);
