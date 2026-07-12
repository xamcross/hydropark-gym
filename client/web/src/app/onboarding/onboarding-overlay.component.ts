import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { PanelDockComponent } from '../shared/panel-dock/panel-dock.component';
import { OnboardingService } from './onboarding.service';

/**
 * ONBOARDING OVERLAY (P1-11.4 · SPEC §16.1) — the first-run "magic" surface.
 *
 * A single focus-trapped modal dialog that steps the user through:
 *   1. WELCOME — the offline-agent idea in one honest paragraph.
 *   2. HARDWARE — calls `get_hardware_profile` (via the service) and shows an
 *      honest tok/s tier + speed note. Never gates anything (P0-02.3).
 *   3. MODEL — the BUNDLED model's real name + size + "already on disk" state.
 *      No fake progress bar: there is no downloader yet, so we don't animate one.
 *   4. TOUR — enables the FREE skill and scripts the §9.6 enable transform beat
 *      (reusing the real `PanelDockComponent`) so representative panels animate
 *      in — the "wow" moment. Reduce-motion aware (PanelDock + motion tokens).
 *   5. EMAIL — OPTIONAL capture, prompted but never required (matches P1-09.1).
 *
 * On completion the flag is set and the overlay unmounts, handing off to the
 * normal shell — with the free skill already enabled from the tour.
 *
 * OnPush + signals throughout; token-only styling; full keyboard + ARIA (dialog
 * role, aria-modal, labelled/described by the live step, Tab focus trap, Escape
 * to skip, per-step heading focus).
 */
@Component({
  selector: 'app-onboarding-overlay',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PanelDockComponent],
  templateUrl: './onboarding-overlay.component.html',
  styleUrl: './onboarding-overlay.component.css',
})
export class OnboardingOverlayComponent {
  readonly svc = inject(OnboardingService);

  /** Stable ids that the (single, live) step heading/description carry for aria wiring. */
  readonly titleId = 'ob-step-title';
  readonly descId = 'ob-step-desc';

  private readonly dialogEl = viewChild<ElementRef<HTMLElement>>('dialog');
  private readonly stepHeading = viewChild<ElementRef<HTMLElement>>('stepHeading');

  /** Local draft for the optional email field (never leaves the device unless submitted). */
  readonly emailDraft = signal('');

  /** The footer's primary action label depends on the step + tour state. */
  readonly primaryLabel = computed(() => {
    const step = this.svc.step();
    if (step === 'tour' && !this.svc.skillEnabled()) return 'Enable Kitchen Timer & Units';
    return this.svc.isLast() ? 'Finish' : 'Next';
  });

  constructor() {
    // Move focus to each step's heading as it becomes active (and on first open),
    // so screen-reader users land on the new step's title. Deferred a tick so the
    // @switch content for the new step is in the DOM before we focus it.
    effect(() => {
      // Register deps: re-run whenever the flow opens or the step changes.
      this.svc.active();
      this.svc.step();
      if (!this.svc.active()) return;
      setTimeout(() => this.stepHeading()?.nativeElement.focus(), 0);
    });
  }

  // --- footer / navigation -------------------------------------------------

  onPrimary(): void {
    const step = this.svc.step();
    // On the tour step, the primary CTA first ENABLES the skill (so the user sees
    // the panels animate in) before it becomes a plain "Next".
    if (step === 'tour' && !this.svc.skillEnabled()) {
      void this.svc.enableFreeSkill();
      return;
    }
    if (this.svc.isLast()) {
      this.commitEmailIfAny();
      this.svc.complete();
      return;
    }
    this.svc.next();
  }

  // --- email step ----------------------------------------------------------

  onEmailInput(value: string): void {
    this.emailDraft.set(value);
    this.svc.clearEmailStatus();
  }

  notifyMe(): void {
    this.svc.captureEmail(this.emailDraft());
  }

  /** Forgiving: if the user typed a valid address but didn't click "Notify me", keep it on Finish. */
  private commitEmailIfAny(): void {
    const draft = this.emailDraft().trim();
    if (draft && this.svc.emailStatus() !== 'saved') this.svc.captureEmail(draft);
  }

  // --- keyboard: Escape to skip, Tab trap ----------------------------------

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.svc.skip();
      return;
    }
    if (event.key === 'Tab') this.trapTab(event);
  }

  private trapTab(event: KeyboardEvent): void {
    const root = this.dialogEl()?.nativeElement;
    if (!root) return;
    const nodes = Array.from(
      root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ).filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (nodes.length === 0) return;

    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement as HTMLElement | null;

    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }
}
