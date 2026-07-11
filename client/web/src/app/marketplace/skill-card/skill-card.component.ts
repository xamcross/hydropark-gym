import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { CatalogItem, formatPrice, formatSize, runsOnThisPc } from '../catalog.model';

/**
 * One catalog card (SPEC §11.1): icon, name, one-line pitch, category, price/
 * "Free" badge, size, and a hardware-requirement / "Runs on your PC" badge.
 *
 * The whole card is a single `<button>` — an in-app activation, not a URL — so
 * it is reachable by keyboard and exposes one accessible name (the skill name).
 * Presentational only: it emits `activate` with its item; the grid owns
 * selection and data.
 */
@Component({
  selector: 'app-skill-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './skill-card.component.html',
  styleUrl: './skill-card.component.css',
})
export class SkillCardComponent {
  readonly item = input.required<CatalogItem>();
  /** Device model tier the "Runs on your PC" badge checks against. */
  readonly deviceTier = input<string>('mid');

  readonly activate = output<CatalogItem>();

  readonly priceLabel = computed(() => formatPrice(this.item().price, this.item().is_free));
  readonly sizeLabel = computed(() => formatSize(this.item().size));
  readonly canRun = computed(() => runsOnThisPc(this.item().requirements, this.deviceTier()));

  onActivate(): void {
    this.activate.emit(this.item());
  }
}
