import { Injectable } from '@angular/core';
import { CatalogPort } from './catalog.port';
import {
  CatalogFilters,
  CatalogItem,
  CatalogPage,
  MediaTile,
  Ownership,
  OwnershipState,
  Requirements,
  SkillDetail,
  SkillPreview,
  buildPreview,
  runsOnThisPc,
} from './catalog.model';
import { buildCuratedPreview } from './preview-transcripts';
import { SAMPLE_PROMPTS } from './sample-prompts';

const USD = 'USD';
const MB = 1024 * 1024;

/**
 * Task 18 — real (non-fabricated) app-chrome screenshots, captured via
 * headless Chromium against this exact `ng serve` stub build (see
 * `.superpowers/sdd/task-18-report.md` for the capture method). These are
 * genuine screens — the marketplace grid, each skill's own detail page, the
 * curated try-before-buy preview modal — NOT synthetic "skill panels in use"
 * mockups: a screenshot of composed panels holding real conversation state
 * (a running timer, a populated ingredient list) needs the driven native app,
 * which this stub-only, ng-serve-only task cannot produce. That gap is
 * flagged, not faked, via the trailing placeholder tile below. Only the 2
 * skills actually reachable from the demo grid with a detail page to
 * screenshot (kitchen-timer, cooking-assistant) have entries.
 */
const CAPTURED_MEDIA: Readonly<Record<string, MediaTile[]>> = {
  'kitchen-timer': [
    { alt: 'Browsing the marketplace grid', uri: 'screenshots/02-marketplace-grid.png' },
    { alt: 'Kitchen Timer & Units — skill detail page', uri: 'screenshots/03-skill-detail-kitchen-timer.png' },
    { alt: 'Kitchen Timer & Units — live in a conversation (native-app capture pending)' },
  ],
  'cooking-assistant': [
    { alt: 'Cooking Assistant — skill detail page', uri: 'screenshots/04-skill-detail-cooking-assistant.png' },
    { alt: 'Cooking Assistant — try-before-buy preview', uri: 'screenshots/05-skill-preview-modal.png' },
    { alt: 'Cooking Assistant — live in a conversation (native-app capture pending)' },
  ],
};

/** requirements presets — mirrors the backend "small"/"large" model tiers. */
const REQ_SMALL: Requirements = { min_model_tier: 'small', min_app_version: '1.0.0' };
const REQ_LARGE: Requirements = { min_model_tier: 'large', min_app_version: '1.2.0' };

/**
 * One backing record per sample skill: the list-row projection, the detail
 * projection, and the current ownership state — everything the three port
 * methods slice out of. NO `system_prompt` anywhere (SF8): the richest prompt
 * text a record holds is `detail.compressed_prompt`.
 */
interface StubRecord {
  item: CatalogItem;
  detail: SkillDetail;
  state: OwnershipState;
}

/**
 * In-memory {@link CatalogPort} so the marketplace components build/run with no
 * backend (see the port javadoc). A handful of skills across several categories
 * and every ownership state, so the grid, detail and ownership button all have
 * real material to render. The real HTTP/IPC adapter replaces this class whole.
 */
@Injectable()
export class StubCatalogPort extends CatalogPort {
  /** Fixed device tier the "runs on your PC" logic checks against (stub). */
  private readonly deviceTier = 'mid';

  private readonly records: StubRecord[] = [
    this.record({
      id: 'kitchen-timer',
      name: 'Kitchen Timer & Units',
      icon: '⏱️',
      category: 'Cooking',
      pitch: 'Named timers, an ingredient list, and exact US/Metric conversion.',
      description:
        'The free onboarding skill. Mounts a timer stack, an editable ingredient list, and a ' +
        'US↔Metric toggle that re-converts every quantity exactly. Ask the agent to cook and the ' +
        'panels fill themselves in.',
      isFree: true,
      requirements: REQ_SMALL,
      size: 3 * MB,
      version: '1.0.4',
      panels: ['Timer stack', 'Ingredient list', 'Units toggle'],
      tools: ['start_timer', 'convert_units', 'list_manage'],
      samplePrompts: ['Help me cook carbonara for 4', 'Start a 9 minute pasta timer', 'Show that in metric'],
      changelog: '1.0.4 — smoother timer ticks under reduced-motion.\n1.0.0 — initial release.',
      compressedPrompt: 'You help with cooking: keep timers, an ingredient list, and unit conversions in sync…',
      hasPreview: false,
      state: 'active',
    }),
    this.record({
      id: 'packing-list',
      name: 'Packing List',
      icon: '🧳',
      category: 'Travel',
      pitch: 'Build a trip packing checklist that adapts to weather and length.',
      description:
        'The second free skill. Turns "5 days in Lisbon, carry-on only" into a categorised, ' +
        'checkable packing list you can tick off as you pack.',
      isFree: true,
      requirements: REQ_SMALL,
      size: 2 * MB,
      version: '1.1.0',
      panels: ['Checklist', 'Category groups'],
      tools: ['list_manage'],
      samplePrompts: ['Pack for 5 days in Lisbon, carry-on only', 'Add a rain layer', 'Check off toiletries'],
      changelog: '1.1.0 — weather-aware suggestions.\n1.0.0 — initial release.',
      compressedPrompt: 'You build and maintain a travel packing checklist grouped by category…',
      hasPreview: false,
      state: 'owned-not-installed',
    }),
    this.record({
      id: 'cooking-assistant',
      name: 'Cooking Assistant',
      icon: '👩‍🍳',
      category: 'Cooking',
      pitch: 'Step-by-step recipes with per-step timers, scaling, and substitutions.',
      description:
        'The paid cooking companion. Walks a recipe step by step, arms a timer per step, scales ' +
        'servings, and suggests substitutions when you are missing an ingredient.',
      isFree: false,
      priceMinor: 500,
      requirements: REQ_SMALL,
      size: 6 * MB,
      version: '2.0.1',
      panels: ['Recipe steps', 'Per-step timers', 'Serving scaler', 'Substitutions'],
      tools: ['start_timer', 'convert_units', 'list_manage'],
      samplePrompts: ['Walk me through a risotto', 'Scale this to 6 servings', 'What can I use instead of buttermilk?'],
      changelog: '2.0.1 — better substitution ranking.\n2.0.0 — step-by-step rewrite.',
      compressedPrompt: 'You guide a cook through a recipe one step at a time, arming a timer for each step…',
      hasPreview: true,
      state: 'not-owned',
    }),
    this.record({
      id: 'budget-planner',
      name: 'Budget Planner',
      icon: '💰',
      category: 'Finance',
      pitch: 'Turn a rough monthly budget into tracked categories and a running balance.',
      description:
        'A paid personal-finance skill. Splits income into categories, tracks spend against each, ' +
        'and shows a running balance — all local, nothing leaves your machine.',
      isFree: false,
      priceMinor: 500,
      requirements: REQ_SMALL,
      size: 5 * MB,
      version: '1.3.2',
      panels: ['Category table', 'Balance meter'],
      tools: ['list_manage'],
      samplePrompts: ['Budget $3,200/month', 'Add groceries at $600', 'How much is left this month?'],
      changelog: '1.3.2 — running-balance rounding fix.\n1.0.0 — initial release.',
      compressedPrompt: 'You maintain a monthly budget: categories, per-category spend, and a running balance…',
      hasPreview: true,
      state: 'installed',
    }),
    this.record({
      id: 'code-reviewer',
      name: 'Code Reviewer',
      icon: '🧑‍💻',
      category: 'Developer',
      pitch: 'A local diff reviewer that flags bugs and suggests cleanups.',
      description:
        'A paid developer skill. Reads a pasted diff and calls out correctness bugs and simple ' +
        'cleanups. Needs a larger local model, so it will not run on every machine.',
      isFree: false,
      priceMinor: 500,
      requirements: REQ_LARGE,
      size: 14 * MB,
      version: '0.9.0',
      panels: ['Findings list', 'Diff view'],
      tools: ['list_manage'],
      samplePrompts: ['Review this diff', 'Any correctness bugs?', 'Suggest a simpler version'],
      changelog: '0.9.0 — beta.',
      compressedPrompt: 'You review a code diff for correctness bugs and simple, safe cleanups…',
      hasPreview: true,
      state: 'not-owned',
    }),
  ];

  // ── CatalogPort ────────────────────────────────────────────────────────────

  async getCatalog(filters: CatalogFilters): Promise<CatalogPage> {
    await this.latency();
    const q = (filters.search ?? '').trim().toLowerCase();
    const items = this.records
      .map((r) => r.item)
      .filter((it) => this.matchesOwnership(it, filters.ownership ?? 'all'))
      .filter((it) => !filters.category || it.category === filters.category)
      .filter((it) => !filters.runsOnThisPc || runsOnThisPc(it.requirements, this.deviceTier))
      .filter(
        (it) =>
          !q ||
          it.name.toLowerCase().includes(q) ||
          (it.pitch ?? '').toLowerCase().includes(q) ||
          (it.category ?? '').toLowerCase().includes(q)
      );
    // Single-page stub: everything fits on page one, so the cursor is always null.
    return { items, next_cursor: null };
  }

  async getDetail(id: string): Promise<SkillDetail> {
    await this.latency();
    const rec = this.records.find((r) => r.item.id === id);
    if (!rec) throw new Error(`unknown skill "${id}"`);
    // Task 18: curated real-model sample prompts / captured screenshots win over
    // the record's own placeholder content when available — same "curated wins"
    // pattern `getPreview()` already uses for the transcript below.
    const curatedPrompts = SAMPLE_PROMPTS[id];
    const capturedMedia = CAPTURED_MEDIA[id];
    if (!curatedPrompts?.length && !capturedMedia) return rec.detail;
    return {
      ...rec.detail,
      ...(curatedPrompts?.length ? { sample_prompts: curatedPrompts } : {}),
      ...(capturedMedia ? { media: capturedMedia } : {}),
    };
  }

  async ownership(id: string): Promise<Ownership> {
    await this.latency();
    const rec = this.records.find((r) => r.item.id === id);
    if (!rec) throw new Error(`unknown skill "${id}"`);
    return { skill_id: id, state: rec.state };
  }

  async getPreview(id: string): Promise<SkillPreview> {
    await this.latency();
    // Task 17 (phase 2): a curated REAL-MODEL transcript wins over the synthetic
    // one whenever the capture bin produced one for this skill — buyers see what
    // the app actually rendered for a real conversation, not a canned reply
    // templated from the sample prompts. Still display-only (SPEC §11.4): no
    // license, no unlock, either way.
    const curated = buildCuratedPreview(id);
    if (curated) return curated;
    const rec = this.records.find((r) => r.item.id === id);
    if (!rec) throw new Error(`unknown skill "${id}"`);
    if (!rec.detail.has_preview) throw new Error(`"${id}" has no preview`);
    // A preview is display-only: assemble it from the already-public detail
    // fields (panels + sample prompts). No license, no unlock (SPEC §11.4).
    return buildPreview(rec.detail);
  }

  // ── helpers ─────────────────────────────────────────────────────────────────

  private matchesOwnership(it: CatalogItem, filter: CatalogFilters['ownership']): boolean {
    switch (filter) {
      case 'free':
        return it.is_free;
      case 'owned':
        return it.owned === true;
      default:
        return true;
    }
  }

  /** Small async delay so loading states are observable in the stub. */
  private latency(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 120));
  }

  /** Build a full record from a flat spec — keeps the sample table readable. */
  private record(spec: {
    id: string;
    name: string;
    icon: string;
    category: string;
    pitch: string;
    description: string;
    isFree: boolean;
    priceMinor?: number;
    requirements: Requirements;
    size: number;
    version: string;
    panels: string[];
    tools: string[];
    samplePrompts: string[];
    changelog: string;
    compressedPrompt: string;
    hasPreview: boolean;
    state: OwnershipState;
  }): StubRecord {
    const price = spec.isFree ? null : { amount: spec.priceMinor ?? 500, currency: USD };
    const owned = spec.state !== 'not-owned' && spec.state !== 'purchasing';
    const item: CatalogItem = {
      kind: 'skill',
      id: spec.id,
      name: spec.name,
      category: spec.category,
      price,
      is_free: spec.isFree,
      requirements: spec.requirements,
      size: spec.size,
      current_version: spec.version,
      owned,
      icon: spec.icon,
      pitch: spec.pitch,
    };
    const detail: SkillDetail = {
      id: spec.id,
      name: spec.name,
      category: spec.category,
      is_free: spec.isFree,
      status: 'published',
      price,
      compressed_prompt: spec.compressedPrompt,
      has_preview: spec.hasPreview,
      min_model_tier: spec.requirements.min_model_tier,
      requirements: spec.requirements,
      current_version: {
        version: spec.version,
        min_app_version: spec.requirements.min_app_version,
        size: spec.size,
        sha256: null,
        is_current: true,
        changelog: spec.changelog,
        status: 'published',
      },
      changelog: spec.changelog,
      owned,
      icon: spec.icon,
      pitch: spec.pitch,
      description: spec.description,
      media: [
        { alt: `${spec.name} — main panel` },
        { alt: `${spec.name} — in a conversation` },
        { alt: `${spec.name} — settings` },
      ],
      panels: spec.panels,
      tools: spec.tools,
      sample_prompts: spec.samplePrompts,
    };
    return { item, detail, state: spec.state };
  }
}
