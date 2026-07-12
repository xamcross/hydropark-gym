import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { NotificationService } from '../shared/notify/notification.service';
import { CatalogGridComponent } from './catalog-grid/catalog-grid.component';
import { SkillDetailComponent } from './skill-detail/skill-detail.component';
import { CatalogItem, OwnershipAction } from './catalog.model';

/**
 * The marketplace surface (SPEC §11): the catalog grid, and — when a card is
 * activated — that skill's detail page, with a back affordance. Data flows only
 * through the injected {@link CATALOG_PORT} (bound to the real IPC adapter under
 * Tauri, the stub otherwise). Ownership INTENTS from the detail page are surfaced
 * as toasts here; routing them to `order_checkout` / `license_fetch` /
 * `download_url` is the auth/purchase tranche — the detail page still simulates
 * the §11.3 state machine locally so the flow is demonstrable meanwhile.
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
  private readonly notify = inject(NotificationService);

  /** Device model tier the cards/detail "runs on your PC" badge checks against. */
  readonly deviceTier = input<string>('mid');

  readonly selected = signal<CatalogItem | null>(null);

  open(item: CatalogItem): void {
    this.selected.set(item);
  }

  close(): void {
    this.selected.set(null);
  }

  onAction(evt: { skillId: string; action: OwnershipAction }): void {
    // Plumbing only for now — the purchase/license/download commands land in the
    // auth tranche. Acknowledge the intent so it's visible end-to-end.
    this.notify.toast({
      title: 'Marketplace',
      body: `${evt.action} · ${evt.skillId}`,
      severity: 'info',
    });
  }
}
