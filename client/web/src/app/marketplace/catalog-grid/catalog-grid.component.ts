import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { CATALOG_PORT } from '../catalog.port';
import { CatalogFilters, CatalogItem, OwnershipFilter } from '../catalog.model';
import { SkillCardComponent } from '../skill-card/skill-card.component';

type Phase = 'loading' | 'ready' | 'empty' | 'error';

interface OwnershipOption {
  value: OwnershipFilter;
  label: string;
}

/**
 * The marketplace catalog (SPEC §11.1): a responsive grid of skill cards, a
 * category chip row, a search box, and the Free/Owned/All + category +
 * "Runs on your PC" filters. Emits `select` when a card is activated.
 *
 * Data comes only through the injected {@link CATALOG_PORT}; filter changes
 * re-query it (search is debounced). Loading / empty / error states are all
 * rendered. Standalone + OnPush.
 */
@Component({
  selector: 'app-catalog-grid',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SkillCardComponent],
  templateUrl: './catalog-grid.component.html',
  styleUrl: './catalog-grid.component.css',
})
export class CatalogGridComponent implements OnInit {
  private readonly port = inject(CATALOG_PORT);

  /** Device model tier the cards' "Runs on your PC" badge checks against. */
  readonly deviceTier = input<string>('mid');

  /** A card was activated — the host opens its detail view. */
  readonly select = output<CatalogItem>();

  // --- filter state ---
  readonly search = signal('');
  readonly category = signal<string | null>(null);
  readonly ownership = signal<OwnershipFilter>('all');
  readonly runsOnThisPc = signal(false);

  // --- results ---
  readonly phase = signal<Phase>('loading');
  readonly items = signal<CatalogItem[]>([]);
  readonly nextCursor = signal<string | null>(null);
  readonly errorMsg = signal<string | null>(null);
  /** Category vocabulary for the chip row — captured once from the full catalog. */
  readonly categories = signal<string[]>([]);

  readonly ownershipOptions: readonly OwnershipOption[] = [
    { value: 'all', label: 'All' },
    { value: 'free', label: 'Free' },
    { value: 'owned', label: 'Owned' },
  ];

  /** True when the empty state is a consequence of the active filters. */
  readonly filtersActive = computed(
    () => !!this.search().trim() || this.category() !== null || this.ownership() !== 'all' || this.runsOnThisPc()
  );

  private readonly filters = computed<CatalogFilters>(() => ({
    search: this.search(),
    category: this.category(),
    ownership: this.ownership(),
    runsOnThisPc: this.runsOnThisPc(),
  }));

  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  ngOnInit(): void {
    void this.loadCategories();
    void this.reload();
  }

  // --- filter handlers ---

  onSearch(value: string): void {
    this.search.set(value);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => void this.reload(), 220);
  }

  selectCategory(cat: string | null): void {
    this.category.set(cat);
    void this.reload();
  }

  setOwnership(value: OwnershipFilter): void {
    this.ownership.set(value);
    void this.reload();
  }

  toggleRunsOnThisPc(checked: boolean): void {
    this.runsOnThisPc.set(checked);
    void this.reload();
  }

  clearFilters(): void {
    this.search.set('');
    this.category.set(null);
    this.ownership.set('all');
    this.runsOnThisPc.set(false);
    void this.reload();
  }

  onCardActivate(item: CatalogItem): void {
    this.select.emit(item);
  }

  // --- data ---

  async reload(): Promise<void> {
    this.phase.set('loading');
    this.errorMsg.set(null);
    try {
      const page = await this.port.getCatalog(this.filters());
      this.items.set(page.items);
      this.nextCursor.set(page.next_cursor);
      this.phase.set(page.items.length ? 'ready' : 'empty');
    } catch (e) {
      this.errorMsg.set(e instanceof Error ? e.message : String(e));
      this.phase.set('error');
    }
  }

  private async loadCategories(): Promise<void> {
    try {
      const page = await this.port.getCatalog({ ownership: 'all' });
      const cats = Array.from(
        new Set(page.items.map((i) => i.category).filter((c): c is string => !!c))
      ).sort((a, b) => a.localeCompare(b));
      this.categories.set(cats);
    } catch {
      // Non-fatal: the chip row simply stays hidden if the vocabulary can't load.
    }
  }
}
