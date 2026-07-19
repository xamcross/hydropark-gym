/**
 * Hydropark Phase-1 — marketplace client model (P1-08.1/.3/.5).
 *
 * TypeScript mirror of the backend catalog DTOs
 * (`backend/src/main/java/io/hydropark/catalog/dto/`). Field names are the
 * on-the-wire JSON names (snake_case, matching the `@JsonProperty` annotations)
 * so the later real HTTP/IPC adapter deserializes straight into these shapes —
 * same convention the IPC contract (`ipc/contract.ts`) uses.
 *
 * ── IP PROTECTION (BE §4.2 SF8) ──────────────────────────────────────────────
 * There is NO `system_prompt` field anywhere in this file, and there never will
 * be. Detail/preview responses carry `compressed_prompt` ONLY — the compressed
 * teaser the backend is willing to expose — never the full paid persona. Any
 * future field must preserve that invariant. (Mirrors the SkillDetailDto javadoc:
 * "that field does not exist anywhere in this package … and never will".)
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── primitives (mirror io.hydropark.common.Money / RequirementsDto) ──────────

/** Money is minor units + ISO-4217 code — never a float (BE §11). */
export interface Money {
  /** Minor units (e.g. cents). `500` == $5.00. */
  amount: number;
  /** ISO-4217 alpha-3, e.g. "USD". */
  currency: string;
}

/** Device/model requirements shown on the card and detail (RequirementsDto). */
export interface Requirements {
  /** Backend vocabulary: "small" | "mid"/"medium" | "large" (skill_manager.rs). */
  min_model_tier: string | null;
  min_app_version: string | null;
}

// ── catalog list row (mirror CatalogItemDto) ─────────────────────────────────

export type CatalogKind = 'skill' | 'bundle';

/**
 * One row of `GET /catalog` (CatalogItemDto). `category`/`requirements`/`size`/
 * `current_version` are null for bundle rows; `owned` is null (never false) for
 * anonymous callers so "not authenticated" is distinguishable from "not owned".
 *
 * `icon` and `pitch` are the SPEC §11.1 card fields the list DTO does not yet
 * carry (the same media/summary gap SkillDetailDto's javadoc calls out). They
 * are optional UI additions the real adapter will populate once the backend
 * exposes them; the stub supplies them locally.
 */
export interface CatalogItem {
  kind: CatalogKind;
  id: string;
  name: string;
  category: string | null;
  price: Money | null;
  is_free: boolean;
  requirements: Requirements | null;
  /** Package size in bytes. */
  size: number | null;
  current_version: string | null;
  /** null = anonymous caller; true/false = authed + (not) owned. */
  owned: boolean | null;

  // --- SPEC §11.1 card presentation (not yet in the list DTO) ---
  /** Emoji/glyph placeholder standing in for the skill's real icon asset. */
  icon?: string;
  /** One-line pitch. */
  pitch?: string;
}

// ── skill version (mirror SkillVersionDto) ───────────────────────────────────

export interface SkillVersion {
  version: string;
  min_app_version: string | null;
  /** package_bytes. */
  size: number | null;
  sha256: string | null;
  is_current: boolean;
  changelog: string | null;
  status: string;
}

// ── skill detail (mirror SkillDetailDto) — compressed_prompt ONLY ────────────

/** A screenshot tile in the detail "screenshots strip". Placeholder-only in v1. */
export interface MediaTile {
  /** Accessible description — always present so the tile is never icon-only. */
  alt: string;
  /** CDN URI once the backend serves media; absent → render a placeholder tile. */
  uri?: string | null;
}

/**
 * `GET /catalog/skills/{id}` (SkillDetailDto).
 *
 * Carries {@link compressed_prompt} only — NEVER a full system_prompt (SF8).
 * `description`, `media`, `panels`/`tools` and `sample_prompts` are the SPEC
 * §11.1 detail fields the DTO javadoc flags as a backend gap; they are optional
 * here and supplied by the stub, ready for the real adapter.
 */
export interface SkillDetail {
  id: string;
  name: string;
  category: string | null;
  is_free: boolean;
  status: string;
  price: Money | null;
  /**
   * The compressed teaser prompt — the ONLY prompt text ever exposed. This is
   * NOT the paid `system_prompt` (which has no field anywhere and is never on
   * the wire). Shown read-only for transparency.
   */
  compressed_prompt: string | null;
  /** Whether a try-before-buy preview exists (§11.4); the URI itself is not leaked. */
  has_preview: boolean;
  min_model_tier: string | null;
  requirements: Requirements | null;
  current_version: SkillVersion | null;
  changelog: string | null;
  owned: boolean | null;

  // --- SPEC §11.1 detail presentation (backend gap; stub-supplied) ---
  icon?: string;
  pitch?: string;
  /** Marketing description (safe copy — distinct from any persona/IP). */
  description?: string;
  /** Screenshots strip. */
  media?: MediaTile[];
  /** Panels this skill mounts. */
  panels?: string[];
  /** Tools this skill registers. */
  tools?: string[];
  /** Example prompts to try. */
  sample_prompts?: string[];

  /**
   * F05: the skill's manifest-derived §8.5 capability tokens (e.g.
   * `["timers","unit_conversion","list_management"]`), as sourced from the
   * backend (`SkillDetailDto.capabilities` → `ipc::SkillDetail.capabilities`).
   * Present (possibly empty array) on a real `CatalogIpcAdapter` detail;
   * `undefined` on the `ng serve` stub, which supplies `tools` instead — see
   * {@link effectiveCapabilities}, the single place that reconciles the two.
   */
  capabilities?: string[];
}

// ── try-before-buy preview (SPEC §11.4, P1-08.4) ─────────────────────────────
//
// A preview lets a shopper TASTE a paid skill before buying: the demo panels it
// would mount and a CAPPED demo transcript. It is display-only — it NEVER issues
// a license and never unlocks the skill (`no_purchase` is a fixed `true` the UI
// surfaces as a banner). Assembled from the manifest / the backend preview
// endpoint; the full paid `system_prompt` is never part of it (SF8).

/** One line of a capped demo transcript shown in the preview. */
export interface PreviewMessage {
  role: 'user' | 'assistant' | 'system';
  text: string;
}

/** A demo panel the skill would mount, shown as a non-interactive preview tile. */
export interface PreviewPanel {
  /** Widget-type name (contract §1 `type`) — drives the tile glyph. */
  type: string;
  /** Human panel label. */
  title: string;
}

/**
 * A try-before-buy preview (SPEC §11.4). {@link no_purchase} is always `true`:
 * requesting a preview issues NO license and performs NO purchase.
 */
export interface SkillPreview {
  skill_id: string;
  name: string;
  panels: PreviewPanel[];
  transcript: PreviewMessage[];
  /** True when the demo transcript was capped (the real skill continues after purchase). */
  capped: boolean;
  /** Always `true` — a preview issues no license (kept explicit for the banner + guards). */
  no_purchase: true;
}

/** The cap on a preview transcript (SPEC §11.4 — a taste, not the whole thing). */
export const PREVIEW_MAX_MESSAGES = 6;

/**
 * Widget-type guess for a human panel label, so a preview tile shows a plausible
 * glyph. Exported so {@link ../preview-transcripts.ts} can build {@link PreviewPanel}
 * tiles for curated (real-model) previews the same way {@link buildPreview} does
 * for synthetic ones — one glyph-guessing rule, not two.
 */
export function previewWidgetType(label: string): string {
  const l = label.toLowerCase();
  if (l.includes('timer')) return 'timer_stack';
  if (l.includes('step') || l.includes('list') || l.includes('checklist') || l.includes('substitution')) {
    return 'editable_list';
  }
  if (l.includes('table') || l.includes('categor') || l.includes('finding') || l.includes('diff')) {
    return 'table';
  }
  if (l.includes('balance') || l.includes('meter') || l.includes('scal') || l.includes('progress')) {
    return 'progress';
  }
  if (l.includes('toggle') || l.includes('unit')) return 'segmented_toggle';
  return 'media_note';
}

function previewReply(detail: SkillDetail, prompt: string): string {
  const first = (detail.panels && detail.panels[0]) || 'a panel';
  return (
    `Here's how ${detail.name} would help with “${prompt}” — it opens ${first} and walks you ` +
    `through it step by step. Buy the skill to continue past this preview.`
  );
}

/**
 * Assemble a {@link SkillPreview} from a {@link SkillDetail} — the demo panels and
 * a CAPPED demo transcript synthesized from the skill's sample prompts (SPEC
 * §11.4). Pure + shared by every {@link CatalogPort} adapter. Issues NO license;
 * reads only safe, already-public detail fields (never a `system_prompt`).
 */
export function buildPreview(detail: SkillDetail): SkillPreview {
  const panels: PreviewPanel[] = (detail.panels ?? []).map((p) => ({ type: previewWidgetType(p), title: p }));
  const prompts = detail.sample_prompts ?? [];

  const full: PreviewMessage[] = [
    { role: 'system', text: `Preview of ${detail.name} — a taste of the skill. Nothing here is purchased.` },
  ];
  for (const q of prompts) {
    full.push({ role: 'user', text: q });
    full.push({ role: 'assistant', text: previewReply(detail, q) });
  }
  const transcript = full.slice(0, PREVIEW_MAX_MESSAGES);

  return {
    skill_id: detail.id,
    name: detail.name,
    panels,
    transcript,
    capped: full.length > transcript.length,
    no_purchase: true,
  };
}

// ── catalog query + page (BE §4.2 cursor pagination) ─────────────────────────

/** Free / Owned / All filter (SPEC §11.1). */
export type OwnershipFilter = 'all' | 'free' | 'owned';

/** The filter/query state the grid sends to the port. */
export interface CatalogFilters {
  /** Free-text search over name/pitch/category. */
  search?: string;
  /** Selected category chip; null/undefined = all categories. */
  category?: string | null;
  ownership?: OwnershipFilter;
  /** "requirements your PC can run" (SPEC §11.1). */
  runsOnThisPc?: boolean;
  /** Opaque forward cursor (BE §4.2); null/undefined = first page. */
  cursor?: string | null;
}

/** One page of `GET /catalog`. */
export interface CatalogPage {
  items: CatalogItem[];
  /** Opaque next-page cursor, or null at the end (BE §4.2). */
  next_cursor: string | null;
}

// ── ownership-state model (SPEC §11.3) ───────────────────────────────────────
//
//   Not owned → (Buy) → Owned/Not installed → (Install) → Installed
//             → (Enable, disabled until installed) → Active
//
// Transient states (`purchasing`/`installing`/`enabling`) cover the async
// windows: `purchasing` is the webhook-confirmed unlock poll (§13.2), the
// others the local download/enable. They render busy + non-activatable.

export type OwnershipState =
  | 'not-owned'
  | 'purchasing'
  | 'owned-not-installed'
  | 'installing'
  | 'installed'
  | 'enabling'
  | 'active';

/** Intents the button emits; the host (later ticket) routes them to IPC/HTTP. */
export type OwnershipAction = 'buy' | 'install' | 'enable' | 'disable' | 'uninstall';

/** `ownership(id)` result — the effective per-skill state for this device. */
export interface Ownership {
  skill_id: string;
  state: OwnershipState;
  /** Non-null in a recoverable error state; surfaced, never destructive. */
  error?: string | null;
}

/** The primary call-to-action descriptor derived from an ownership state. */
export interface OwnershipCta {
  /** The action to emit on activation, or null for a non-actionable status. */
  action: OwnershipAction | null;
  label: string;
  emphasis: 'strong' | 'normal' | 'subtle';
  /** Busy (in-flight) — spinner + aria-busy + non-activatable. */
  pending: boolean;
  /** Not activatable (status-only or in-flight). */
  disabled: boolean;
}

/**
 * Pure map from ownership state → the PRIMARY CTA. The secondary "Enable
 * (disabled until installed)" and "Disable" affordances are rendered by the
 * component from the state directly.
 */
export function primaryCta(state: OwnershipState, price: Money | null, isFree: boolean): OwnershipCta {
  switch (state) {
    case 'not-owned':
      return isFree
        ? { action: 'install', label: 'Get · Free', emphasis: 'strong', pending: false, disabled: false }
        : { action: 'buy', label: `Buy ${formatPrice(price, false)}`, emphasis: 'strong', pending: false, disabled: false };
    case 'purchasing':
      return { action: null, label: 'Purchase pending…', emphasis: 'strong', pending: true, disabled: true };
    case 'owned-not-installed':
      return { action: 'install', label: 'Install', emphasis: 'strong', pending: false, disabled: false };
    case 'installing':
      return { action: null, label: 'Installing…', emphasis: 'strong', pending: true, disabled: true };
    case 'installed':
      return { action: 'enable', label: 'Enable', emphasis: 'strong', pending: false, disabled: false };
    case 'enabling':
      return { action: null, label: 'Enabling…', emphasis: 'strong', pending: true, disabled: true };
    case 'active':
      return { action: null, label: 'Active', emphasis: 'subtle', pending: false, disabled: true };
  }
}

/** True once the skill is installed (Enable is only actionable from here on). */
export function isInstalled(state: OwnershipState): boolean {
  return state === 'installed' || state === 'enabling' || state === 'active';
}

// ── capability disclosure (Task 10, SPEC §8.5 / §11) ─────────────────────────
//
// `SkillDetail` carries no `capabilities` field (neither on the wire nor in
// `ipc.rs`'s `SkillDetail` DTO) — only `tools`, the tool REFS the skill
// registers (e.g. `"start_timer"`). The install-time "This skill can: …"
// disclosure needs CAPABILITY tokens (e.g. `"timers"`), so this derives them
// from `tools` via the same tool→capability mapping the Rust catalog owns
// (`tool_catalog.rs`'s `CATALOG` descriptors' `capability` field — mirrored
// here verbatim; the Rust side is the source of truth for the mapping).

/** Tool ref → §8.5 capability category, mirroring `tool_catalog.rs`'s `CATALOG`
 * descriptors exactly (`start_timer` → `timers`, etc.). */
const TOOL_CAPABILITY: Record<string, string> = {
  start_timer: 'timers',
  convert_units: 'unit_conversion',
  list_manage: 'list_management',
  calculate: 'calculation',
  date_math: 'date_math',
};

/**
 * Derive the (deduped, order-preserving) capability tokens a skill's `tools`
 * imply, for the `capability_disclose` IPC call. An unrecognised tool ref is
 * skipped rather than surfaced — the fixed 5-tool catalog is closed, so this
 * only happens for forward-incompatible data, and silently omitting it from
 * the summary is safer than blocking install-time disclosure on it.
 */
export function capabilitiesForTools(tools: string[] | undefined | null): string[] {
  if (!tools) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tools) {
    const cap = TOOL_CAPABILITY[t];
    if (cap && !seen.has(cap)) {
      seen.add(cap);
      out.push(cap);
    }
  }
  return out;
}

/**
 * F05: the single place that decides what the capability-consent dialog
 * discloses. `CatalogIpcAdapter` (the real backend path) now populates {@link
 * SkillDetail.capabilities} directly from the backend's certified manifest
 * data — that is the honest source and wins whenever it is present, even if
 * empty. `StubCatalogPort` (the `ng serve` fallback) does not set it, only
 * `tools`, so falling back to {@link capabilitiesForTools} keeps the stub's
 * disclosure exactly as it was before this field existed.
 */
export function effectiveCapabilities(detail: Pick<SkillDetail, 'capabilities' | 'tools'>): string[] {
  if (detail.capabilities !== undefined) return detail.capabilities;
  return capabilitiesForTools(detail.tools);
}

// ── formatting + hardware-fit helpers (presentational, pure) ─────────────────

/** "$5" / "$4.99" / "Free" (SPEC §11.1). Whole amounts drop the decimals. */
export function formatPrice(price: Money | null, isFree: boolean): string {
  if (isFree || !price || price.amount === 0) return 'Free';
  const major = price.amount / 100;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: price.currency,
      minimumFractionDigits: Number.isInteger(major) ? 0 : 2,
    }).format(major);
  } catch {
    // Unknown/invalid currency code — fall back to a plain amount + code.
    return `${major} ${price.currency}`;
  }
}

/** "12 MB" / "512 KB" / "—" for the size badge. */
export function formatSize(bytes: number | null | undefined): string {
  if (bytes == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  const rounded = i === 0 || n >= 10 ? Math.round(n) : Math.round(n * 10) / 10;
  return `${rounded} ${units[i]}`;
}

/**
 * Model-capability tier ordering, mirroring the Rust core
 * (`skill_manager.rs`: Small < Mid < Large; a skill is compatible iff
 * `skill.min_model_tier <= device_tier`). Unknown strings sort as most
 * permissive (0) so an unrecognised tier never *falsely* blocks a skill.
 */
const MODEL_TIER_RANK: Record<string, number> = {
  small: 0,
  s: 0,
  mid: 1,
  medium: 1,
  m: 1,
  large: 2,
  l: 2,
};

function tierRank(tier: string | null | undefined): number {
  if (!tier) return 0;
  return MODEL_TIER_RANK[tier.toLowerCase()] ?? 0;
}

/**
 * "requirements your PC can run" (SPEC §11.1): true iff the skill's required
 * model tier is at or below the device's. No requirement → always runnable.
 */
export function runsOnThisPc(requirements: Requirements | null | undefined, deviceTier: string): boolean {
  return tierRank(requirements?.min_model_tier) <= tierRank(deviceTier);
}
