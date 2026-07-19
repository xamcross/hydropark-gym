import { Injectable, inject } from '@angular/core';
import { IPC_PORT } from '../ipc/ipc.port';
import { AuthService } from '../account/auth.service';
import { TelemetryService } from '../state/telemetry.service';
import {
  CatalogItem as IpcCatalogItem,
  EntitlementItem,
  SkillDetail as IpcSkillDetail,
} from '../ipc/contract';
import { CatalogPort } from './catalog.port';
import {
  CatalogFilters,
  CatalogItem,
  CatalogPage,
  Money,
  Ownership,
  OwnershipFilter,
  OwnershipState,
  SkillDetail,
  SkillPreview,
  buildPreview,
  runsOnThisPc,
} from './catalog.model';

const USD = 'USD';

/**
 * Real {@link CatalogPort} over the Rust IPC bridge (P1 live-flow). It calls the
 * PUBLIC `catalog_list` / `catalog_detail` commands (no bearer) and derives
 * ownership from `entitlements_get` (optional bearer — passed through once the
 * auth tranche mints one). Selected under a Tauri runtime; `StubCatalogPort`
 * remains the `ng serve`/offline fallback (see `catalog.providers.ts`).
 *
 * The IPC catalog DTOs are the compact card/detail projections (camelCase,
 * `priceCents`/`sizeBytes`/`hardwareBadge`/`ownership`); this adapter maps them
 * into the richer marketplace model the components consume. The map is lossy in
 * one direction — the compact list DTO carries a `hardwareBadge` string, not a
 * structured tier, so `requirements` maps to `null` (⇒ "runnable"); the detail
 * DTO fills what it can. IP note: only `compressed_prompt` is ever read; there
 * is no `system_prompt` field to map (SF8).
 */
@Injectable()
export class CatalogIpcAdapter extends CatalogPort {
  private readonly ipc = inject(IPC_PORT);
  private readonly auth = inject(AuthService);
  private readonly telemetry = inject(TelemetryService);

  /** Fixed device tier the "runs on your PC" filter checks against (until hardware profiling threads through). */
  private readonly deviceTier = 'mid';

  /**
   * Access token for the authed calls — sourced from {@link AuthService} (the
   * device/account identity). Omitted (`undefined`) while anonymous, so the
   * public catalog calls stay bearer-less.
   */
  private bearer(): string | undefined {
    return this.auth.bearer();
  }

  async getCatalog(filters: CatalogFilters): Promise<CatalogPage> {
    // Offline-usage share (P1-25.1): this adapter is the real backend path, so
    // every call here means the session was NOT fully offline.
    this.telemetry.noteBackendCall();
    const res = await this.ipc.invoke('catalog_list', {});
    const all = res.skills.map((s) => toModelItem(s));

    // `catalog_list` only takes `region`; the search/category/ownership/runs-on
    // filters are applied client-side (same division as the stub).
    const q = (filters.search ?? '').trim().toLowerCase();
    const items = all
      .filter((it) => matchesOwnership(it, filters.ownership ?? 'all'))
      .filter((it) => !filters.category || it.category === filters.category)
      .filter((it) => !filters.runsOnThisPc || runsOnThisPc(it.requirements, this.deviceTier))
      .filter(
        (it) =>
          !q ||
          it.name.toLowerCase().includes(q) ||
          (it.pitch ?? '').toLowerCase().includes(q) ||
          (it.category ?? '').toLowerCase().includes(q)
      );

    // The list command is single-shot here; cursor pagination threads through later.
    return { items, next_cursor: null };
  }

  async getDetail(id: string): Promise<SkillDetail> {
    this.telemetry.noteBackendCall();
    const d = await this.ipc.invoke('catalog_detail', { skillId: id });
    return toModelDetail(d);
  }

  async ownership(id: string): Promise<Ownership> {
    this.telemetry.noteBackendCall();
    try {
      const res = await this.ipc.invoke('entitlements_get', { bearer: this.bearer() });
      const ent = res.skills.find((s) => s.skillId === id);
      return { skill_id: id, state: entitlementToState(ent) };
    } catch (e) {
      // Not authenticated / entitlements unavailable ⇒ treat as not owned (non-fatal).
      return { skill_id: id, state: 'not-owned', error: e instanceof Error ? e.message : null };
    }
  }

  async getPreview(id: string): Promise<SkillPreview> {
    // Preview is derived from the PUBLIC `catalog_detail` (panels + sample
    // prompts) — display-only, no license, no new IPC command needed (SPEC
    // §11.4). A dedicated backend preview endpoint can replace this later without
    // touching the components.
    this.telemetry.noteBackendCall();
    const detail = toModelDetail(await this.ipc.invoke('catalog_detail', { skillId: id }));
    if (!detail.has_preview) throw new Error(`"${id}" has no preview`);
    return buildPreview(detail);
  }
}

// ── mapping helpers (IPC compact DTO → marketplace model) ────────────────────

function priceFrom(priceCents: number): Money | null {
  return priceCents > 0 ? { amount: priceCents, currency: USD } : null;
}

function toModelItem(s: IpcCatalogItem): CatalogItem {
  return {
    kind: 'skill',
    id: s.id,
    name: s.name,
    category: s.category || null,
    price: priceFrom(s.priceCents),
    is_free: s.priceCents === 0,
    requirements: null,
    size: s.sizeBytes,
    current_version: null,
    owned: ownershipToOwned(s.ownership),
    pitch: s.pitch,
  };
}

function toModelDetail(d: IpcSkillDetail): SkillDetail {
  return {
    id: d.id,
    name: d.name,
    category: d.category || null,
    is_free: d.priceCents === 0,
    status: 'published',
    price: priceFrom(d.priceCents),
    compressed_prompt: d.compressedPrompt ?? null,
    has_preview: d.hasPreview ?? false,
    min_model_tier: null,
    requirements: null,
    current_version: d.currentVersion
      ? {
          version: d.currentVersion,
          min_app_version: null,
          size: d.sizeBytes,
          sha256: null,
          is_current: true,
          changelog: d.changelog ?? null,
          status: 'published',
        }
      : null,
    changelog: d.changelog ?? null,
    owned: ownershipToOwned(d.ownership),
    pitch: d.pitch,
    description: d.description,
    panels: d.panels,
    tools: d.tools,
    sample_prompts: d.samplePrompts,
    // F05: the real capability-disclosure source (SkillDetailDto.capabilities via
    // ipc::SkillDetail.capabilities) — always an array (possibly empty) from the
    // real backend, never derived client-side from `tools` (which the backend
    // never populates). See `catalog.model.ts#effectiveCapabilities`.
    capabilities: d.capabilities ?? [],
  };
}

/** The compact DTO's `ownership` string → the model's tri-state `owned` flag. */
function ownershipToOwned(ownership: string): boolean | null {
  if (!ownership) return null;
  return ownership !== 'not-owned' && ownership !== 'purchasing';
}

/** An entitlement row (or its absence) → the SPEC §11.3 ownership state. */
function entitlementToState(ent: EntitlementItem | undefined): OwnershipState {
  if (!ent) return 'not-owned';
  switch (ent.state) {
    case 'active':
      return 'active';
    case 'installed':
      return 'installed';
    case 'owned':
    case 'owned-not-installed':
      return 'owned-not-installed';
    default:
      return 'owned-not-installed';
  }
}

function matchesOwnership(it: CatalogItem, filter: OwnershipFilter): boolean {
  switch (filter) {
    case 'free':
      return it.is_free;
    case 'owned':
      return it.owned === true;
    default:
      return true;
  }
}
