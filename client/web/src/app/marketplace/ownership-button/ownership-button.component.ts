import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { Money, OwnershipAction, OwnershipState, OwnershipCta, isInstalled, primaryCta } from '../catalog.model';

/**
 * The ownership-state control (SPEC §11.3):
 *
 *   Not owned → (Buy $price) → Owned/Not installed → (Install) → Installed
 *             → (Enable, disabled until installed) → Active
 *
 * Renders the PRIMARY call-to-action for the current {@link state} (label +
 * emphasis + busy/disabled from {@link primaryCta}) plus the secondary
 * affordances the flow calls for:
 *   - owned-but-not-installed → a DISABLED "Enable" (the "disabled until
 *     installed" gate, made literal so the next step is visible), and
 *   - active → a "Disable" button.
 *
 * Purely presentational: it emits an {@link OwnershipAction} intent and never
 * performs the purchase/install/enable itself — the host (a later ticket) wires
 * that to IPC/HTTP. Transient states (`purchasing`/`installing`/`enabling`)
 * render busy (aria-busy) and are non-activatable.
 */
@Component({
  selector: 'app-ownership-button',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './ownership-button.component.html',
  styleUrl: './ownership-button.component.css',
})
export class OwnershipButtonComponent {
  readonly state = input.required<OwnershipState>();
  readonly price = input<Money | null>(null);
  readonly isFree = input<boolean>(false);
  /** Recoverable error to surface below the button (non-destructive). */
  readonly error = input<string | null>(null);

  /** User intent — the host routes it to the purchase/install/enable flow. */
  readonly action = output<OwnershipAction>();

  readonly cta = computed<OwnershipCta>(() => primaryCta(this.state(), this.price(), this.isFree()));

  /** Owned but not yet installed → show the gated (disabled) Enable step. */
  readonly showGatedEnable = computed(() => {
    const s = this.state();
    return s === 'owned-not-installed' || s === 'installing';
  });

  /** Installed + enabled → offer Disable. */
  readonly showDisable = computed(() => this.state() === 'active');

  /** Installed (any of installed/enabling/active) → offer Uninstall to reclaim disk. */
  readonly showUninstall = computed(() => isInstalled(this.state()));

  emit(action: OwnershipAction | null): void {
    if (action) this.action.emit(action);
  }

  onPrimary(): void {
    const cta = this.cta();
    if (cta.disabled || cta.pending) return;
    this.emit(cta.action);
  }
}
