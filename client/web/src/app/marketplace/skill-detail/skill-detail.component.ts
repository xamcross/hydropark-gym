import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { CATALOG_PORT } from '../catalog.port';
import { OwnershipAction, OwnershipState, SkillDetail, formatPrice, formatSize, runsOnThisPc } from '../catalog.model';
import { OwnershipButtonComponent } from '../ownership-button/ownership-button.component';
import { PurchaseService } from '../purchase.service';

type Phase = 'loading' | 'ready' | 'error';

/**
 * Skill detail page (SPEC §11.1): description, a screenshots strip (placeholder
 * tiles), the panels/tools list, sample prompts, size, changelog, requirements
 * badge, and the ownership button (§11.3).
 *
 * ── IP PROTECTION (BE §4.2 SF8) ──────────────────────────────────────────────
 * The only prompt text this view shows is {@link SkillDetail.compressed_prompt}
 * — the compressed teaser. There is no `system_prompt` field on the model and
 * therefore no template binding for one; the full paid persona is never fetched
 * and never rendered.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Data comes only through {@link CATALOG_PORT}, which supplies the BASELINE
 * ownership state ({@link ownState}). Ownership-button intents are routed to
 * {@link PurchaseService} — the real §11.3/§13 commerce loop (checkout in the
 * system browser, settle via poll + `purchase://callback`, license + download,
 * enable) — whose live per-skill override, when present, wins over the baseline
 * ({@link displayState}). The `action` output is still emitted for the host.
 */
@Component({
  selector: 'app-skill-detail',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [OwnershipButtonComponent],
  templateUrl: './skill-detail.component.html',
  styleUrl: './skill-detail.component.css',
})
export class SkillDetailComponent {
  private readonly port = inject(CATALOG_PORT);
  private readonly purchase = inject(PurchaseService);

  readonly skillId = input.required<string>();
  readonly deviceTier = input<string>('mid');

  /** Return to the grid. */
  readonly back = output<void>();
  /** Ownership intent (buy/install/enable/disable/uninstall) for the host to route. */
  readonly action = output<{ skillId: string; action: OwnershipAction }>();

  readonly phase = signal<Phase>('loading');
  readonly detail = signal<SkillDetail | null>(null);
  readonly errorMsg = signal<string | null>(null);
  /** Baseline ownership from the catalog port (before any live purchase this session). */
  readonly ownState = signal<OwnershipState | null>(null);

  /** The live purchase override, when present, wins over the port baseline (§11.3/§13). */
  readonly displayState = computed<OwnershipState | null>(
    () => this.purchase.stateFor(this.skillId()) ?? this.ownState()
  );
  /** Recoverable purchase error to surface non-destructively on the button. */
  readonly ownError = computed(() => this.purchase.errorFor(this.skillId()));

  readonly priceLabel = computed(() => {
    const d = this.detail();
    return d ? formatPrice(d.price, d.is_free) : '';
  });
  readonly sizeLabel = computed(() => formatSize(this.detail()?.current_version?.size ?? null));
  readonly canRun = computed(() => runsOnThisPc(this.detail()?.requirements, this.deviceTier()));

  constructor() {
    // Reload whenever the selected skill changes (initial run included).
    effect(() => {
      const id = this.skillId();
      void this.load(id);
    });
  }

  async load(id: string): Promise<void> {
    this.phase.set('loading');
    this.errorMsg.set(null);
    try {
      const [detail, ownership] = await Promise.all([this.port.getDetail(id), this.port.ownership(id)]);
      this.detail.set(detail);
      this.ownState.set(ownership.state);
      this.phase.set('ready');
    } catch (e) {
      this.errorMsg.set(e instanceof Error ? e.message : String(e));
      this.phase.set('error');
    }
  }

  onBack(): void {
    this.back.emit();
  }

  /** Re-emit the intent for the host, then drive the real commerce flow. */
  onAction(action: OwnershipAction): void {
    const d = this.detail();
    if (!d) return;
    this.action.emit({ skillId: this.skillId(), action });
    this.purchase.dispatch(d, action);
  }
}
