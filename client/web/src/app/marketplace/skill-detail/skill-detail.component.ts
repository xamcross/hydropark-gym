import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { CATALOG_PORT } from '../catalog.port';
import { OwnershipAction, OwnershipState, SkillDetail, formatPrice, formatSize, runsOnThisPc } from '../catalog.model';
import { OwnershipButtonComponent } from '../ownership-button/ownership-button.component';

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
 * Data comes only through {@link CATALOG_PORT}. The ownership button's intents
 * are re-emitted via {@link action} for the host to route; for the standalone
 * stub we ALSO advance a local ownership state through the SPEC §11.3 machine
 * (including the transient purchasing/installing/enabling windows) so the flow
 * is demonstrable with no HTTP/IPC wired.
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

  readonly skillId = input.required<string>();
  readonly deviceTier = input<string>('mid');

  /** Return to the grid. */
  readonly back = output<void>();
  /** Ownership intent (buy/install/enable/disable/uninstall) for the host to route. */
  readonly action = output<{ skillId: string; action: OwnershipAction }>();

  readonly phase = signal<Phase>('loading');
  readonly detail = signal<SkillDetail | null>(null);
  readonly errorMsg = signal<string | null>(null);
  readonly ownState = signal<OwnershipState | null>(null);

  readonly priceLabel = computed(() => {
    const d = this.detail();
    return d ? formatPrice(d.price, d.is_free) : '';
  });
  readonly sizeLabel = computed(() => formatSize(this.detail()?.current_version?.size ?? null));
  readonly canRun = computed(() => runsOnThisPc(this.detail()?.requirements, this.deviceTier()));

  private advanceTimer: ReturnType<typeof setTimeout> | null = null;

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
    if (this.advanceTimer) clearTimeout(this.advanceTimer);
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

  /** Re-emit the intent, then simulate the §11.3 transition locally (stub demo). */
  onAction(action: OwnershipAction): void {
    this.action.emit({ skillId: this.skillId(), action });
    this.simulate(action);
  }

  private simulate(action: OwnershipAction): void {
    const s = this.ownState();
    if (!s) return;
    if (this.advanceTimer) clearTimeout(this.advanceTimer);

    const step = (transient: OwnershipState, settled: OwnershipState, ms: number): void => {
      this.ownState.set(transient);
      this.advanceTimer = setTimeout(() => this.ownState.set(settled), ms);
    };

    switch (action) {
      case 'buy':
        if (s === 'not-owned') step('purchasing', 'owned-not-installed', 900);
        break;
      case 'install':
        if (s === 'owned-not-installed' || s === 'not-owned') step('installing', 'installed', 900);
        break;
      case 'enable':
        if (s === 'installed') step('enabling', 'active', 500);
        break;
      case 'disable':
        if (s === 'active') this.ownState.set('installed');
        break;
      case 'uninstall':
        this.ownState.set('owned-not-installed');
        break;
    }
  }
}
