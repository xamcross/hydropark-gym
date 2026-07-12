import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { SessionService } from '../state/session.service';
import { estimateHardware } from '../onboarding/hardware-tier';

/** Durable dismissal flag — remembered so the banner doesn't nag on every launch. */
const DISMISSED_KEY = 'hydropark.hwwarning.dismissed.v1';

/**
 * HARDWARE-TIER SPEED WARNING (P1-02.6) — a persistent, dismissible shell banner
 * shown ONLY when the computed hardware tier is BELOW the recommended bar
 * (`constrained`, i.e. an estimated ceiling under ~8 tok/s for the bundled 3B
 * model). It reuses {@link estimateHardware} (the same honest verdict onboarding
 * shows) off the shared {@link SessionService.hardwareProfile}, so it lights up as
 * soon as the profile is read at boot and never gates anything (P0-02.3).
 *
 * It self-gates: renders nothing when the profile is unknown, the tier is at/above
 * recommended, or the user has dismissed it (a durable, guarded localStorage flag).
 *
 * Accessibility: the severity is carried by a warning ICON + explicit TEXT
 * ("Slower on this hardware"), never colour alone (WCAG 1.4.1). It is an advisory,
 * so it is a polite `role="status"` region (not an assertive alert), with a real
 * keyboard-focusable dismiss button. Token-only, theme-aware styling.
 *
 * OnPush + signals.
 */
@Component({
  selector: 'app-hardware-warning',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (show()) {
      <div class="hw-warn" role="status" data-tone="careful">
        <span class="hw-warn-icon" aria-hidden="true">&#9888;</span>
        <div class="hw-warn-body">
          <strong class="hw-warn-title">Slower on this hardware</strong>
          <span class="hw-warn-text">{{ verdict().speedNote }} It stays fully usable — replies just stream more deliberately.</span>
          @if (verdict().rangeText) {
            <span class="hw-warn-rate">{{ verdict().rangeText }}</span>
          }
        </div>
        <button
          type="button"
          class="hw-warn-dismiss"
          (click)="dismiss()"
          aria-label="Dismiss hardware speed notice"
          title="Dismiss"
        >
          <span aria-hidden="true">&times;</span>
        </button>
      </div>
    }
  `,
  styleUrl: './hardware-warning.component.css',
})
export class HardwareWarningComponent {
  private readonly session = inject(SessionService);

  /** The same honest verdict the onboarding hardware step renders. */
  readonly verdict = computed(() => estimateHardware(this.session.hardwareProfile()));

  private readonly _dismissed = signal<boolean>(readDismissed());

  /** Below the recommended bar (< ~8 tok/s) is exactly the `constrained` tier. */
  readonly show = computed(() => this.verdict().tier === 'constrained' && !this._dismissed());

  dismiss(): void {
    this._dismissed.set(true);
    writeDismissed();
  }
}

function readDismissed(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, '1');
  } catch {
    /* storage unavailable — the banner just re-shows next launch */
  }
}
