import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { CATALOG_PORT } from '../catalog.port';
import {
  OwnershipAction,
  OwnershipState,
  SkillDetail,
  capabilitiesForTools,
  formatPrice,
  formatSize,
  runsOnThisPc,
} from '../catalog.model';
import { OwnershipButtonComponent } from '../ownership-button/ownership-button.component';
import { SkillPreviewComponent } from '../skill-preview/skill-preview.component';
import { CapabilityConsentComponent } from '../capability-consent/capability-consent.component';
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
 *
 * ── INSTALL-TIME CAPABILITY DISCLOSURE (SPEC §8.5 / §11, Task 10) ───────────
 * `'install'` and `'buy'` intents do NOT reach {@link PurchaseService} directly:
 * {@link onAction} first opens {@link CapabilityConsentComponent} — the B4 trust
 * surface, "This skill can: …" — derived from the skill's `tools` via
 * {@link capabilitiesForTools}. Only on Confirm does the real dispatch run;
 * Cancel aborts with no state change and no `action` emit. `'enable'` /
 * `'disable'` / `'uninstall'` are NOT intercepted — they dispatch immediately,
 * exactly as before.
 * ─────────────────────────────────────────────────────────────────────────────
 */
@Component({
  selector: 'app-skill-detail',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [OwnershipButtonComponent, SkillPreviewComponent, CapabilityConsentComponent],
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

  // --- try-before-buy preview (SPEC §11.4, P1-08.4) ------------------------

  /** Whether this skill offers a preview (drives the "Try a preview" affordance). */
  readonly canPreview = computed<boolean>(() => this.detail()?.has_preview ?? false);
  /** True while the preview modal is open. */
  readonly previewOpen = signal(false);
  /** Offer the in-preview Buy CTA only for a paid skill the user does not yet own. */
  readonly previewCanBuy = computed<boolean>(() => {
    const d = this.detail();
    const st = this.displayState();
    return !!d && !d.is_free && (st === null || st === 'not-owned');
  });

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

  // --- install-time capability disclosure (SPEC §8.5 / §11, Task 10) -------

  /** True while the capability-consent dialog is open. */
  readonly consentOpen = signal(false);
  /** The capability tokens the open dialog discloses (derived from `detail().tools`). */
  readonly consentCapabilities = signal<string[]>([]);
  /** The action awaiting confirmation ('install' | 'buy') — null once resolved. */
  private pendingAction: OwnershipAction | null = null;

  /**
   * `'install'`/`'buy'` open the capability-consent dialog first — the real
   * dispatch (and the `action` emit for the host) only happens on Confirm
   * ({@link onConsentConfirm}). Every other intent is unintercepted, exactly as
   * before.
   */
  onAction(action: OwnershipAction): void {
    const d = this.detail();
    if (!d) return;
    if (action === 'install' || action === 'buy') {
      this.pendingAction = action;
      this.consentCapabilities.set(capabilitiesForTools(d.tools));
      this.consentOpen.set(true);
      return;
    }
    this.dispatchAction(action);
  }

  /** Re-emit the intent for the host, then drive the real commerce flow. */
  private dispatchAction(action: OwnershipAction): void {
    const d = this.detail();
    if (!d) return;
    this.action.emit({ skillId: this.skillId(), action });
    this.purchase.dispatch(d, action);
  }

  /** Confirmed — close the dialog and run the flow the shopper just consented to. */
  onConsentConfirm(): void {
    const action = this.pendingAction;
    this.pendingAction = null;
    this.consentOpen.set(false);
    if (action) this.dispatchAction(action);
  }

  /** Cancelled (button / Escape / backdrop) — close with NO dispatch, NO state change. */
  onConsentCancel(): void {
    this.pendingAction = null;
    this.consentOpen.set(false);
  }

  // --- preview modal control (P1-08.4) -------------------------------------

  openPreview(): void {
    this.previewOpen.set(true);
  }

  closePreview(): void {
    this.previewOpen.set(false);
  }

  /** Buy chosen from inside the preview: dismiss, then run the normal purchase flow. */
  onPreviewBuy(): void {
    this.previewOpen.set(false);
    this.onAction('buy');
  }
}
