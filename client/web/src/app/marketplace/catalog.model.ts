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
