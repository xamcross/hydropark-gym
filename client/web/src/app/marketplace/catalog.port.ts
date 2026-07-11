import { InjectionToken } from '@angular/core';
import { CatalogFilters, CatalogPage, Ownership, SkillDetail } from './catalog.model';

/**
 * The one seam the marketplace UI goes through to reach the catalog (BE §4.2).
 * Two implementations are intended, exactly like the IPC `IpcPort` split:
 *  - `StubCatalogPort`  — in-memory sample data so the components build and run
 *    standalone (`ng serve`/`ng build`) with no backend (this ticket).
 *  - a real HTTP/IPC adapter over `GET /catalog`, `/catalog/skills/{id}`,
 *    `/entitlements` + the ownership lifecycle — a LATER ticket.
 *
 * Components depend only on this abstraction (injected via {@link CATALOG_PORT});
 * nothing in the UI knows which implementation it got.
 *
 * IP note: `getDetail` returns {@link SkillDetail}, whose `compressed_prompt` is
 * the only prompt text ever surfaced — the full `system_prompt` is not part of
 * this contract and cannot be requested through it (SF8).
 */
export abstract class CatalogPort {
  /** One cursor-paginated page of the merged skills+bundles feed (BE §4.2). */
  abstract getCatalog(filters: CatalogFilters): Promise<CatalogPage>;

  /** Detail for one skill — `compressed_prompt` only, never `system_prompt`. */
  abstract getDetail(id: string): Promise<SkillDetail>;

  /** The effective ownership/install/enable state for one skill (SPEC §11.3). */
  abstract ownership(id: string): Promise<Ownership>;
}

export const CATALOG_PORT = new InjectionToken<CatalogPort>('CATALOG_PORT');
