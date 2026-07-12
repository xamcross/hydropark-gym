import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';
import { CatalogGridComponent } from './catalog-grid/catalog-grid.component';
import { SkillDetailComponent } from './skill-detail/skill-detail.component';
import { CatalogItem, OwnershipAction } from './catalog.model';

/**
 * The marketplace surface (SPEC §11): the catalog grid, and — when a card is
 * activated — that skill's detail page, with a back affordance. Data flows only
 * through the injected {@link CATALOG_PORT} (bound to the real IPC adapter under
 * Tauri, the stub otherwise).
 *
 * Ownership intents are now driven END-TO-END: the detail page routes them to
 * {@link PurchaseService} (checkout in the system browser → settle → license +
 * download → enable), which owns all user-facing messaging. The `action` output
 * is retained purely as a host-level hook (telemetry / future routing) and is
 * intentionally quiet here to avoid double toasts.
 */
@Component({
  selector: 'app-marketplace-view',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CatalogGridComponent, SkillDetailComponent],
  template: `
    @if (selected(); as item) {
      <app-skill-detail
        [skillId]="item.id"
        [deviceTier]="deviceTier()"
        (back)="close()"
        (action)="onAction($event)"
      ></app-skill-detail>
    } @else {
      <app-catalog-grid [deviceTier]="deviceTier()" (select)="open($event)"></app-catalog-grid>
    }
  `,
})
export class MarketplaceViewComponent {
  /** Device model tier the cards/detail "runs on your PC" badge checks against. */
  readonly deviceTier = input<string>('mid');

  readonly selected = signal<CatalogItem | null>(null);

  open(item: CatalogItem): void {
    this.selected.set(item);
  }

  close(): void {
    this.selected.set(null);
  }

  /** Host-level hook only — the detail page has already driven the real flow via PurchaseService. */
  onAction(_evt: { skillId: string; action: OwnershipAction }): void {
    // Intentionally quiet: PurchaseService owns pending/settled/error messaging.
  }
}
