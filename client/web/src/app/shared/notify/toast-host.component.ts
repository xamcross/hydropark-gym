import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { NotificationService } from './notification.service';

/**
 * P1-06.7 — the in-app fallback surface for {@link NotificationService} (SPEC
 * §9.7 "degrades to an in-app alert if denied"). Drop ONE instance at the app
 * root; it renders the service's live `toasts` stack:
 *
 *     <app-toast-host />
 *
 * Accessibility:
 *  - each toast is its own live region — `role="alert"` (assertive) for
 *    time-critical alerts, `role="status"` (polite) otherwise;
 *  - `aria-atomic` so the whole message is re-read, not just a diff;
 *  - a real, keyboard-focusable dismiss button with an `aria-label`.
 *
 * Styling is token-only (toast-host.component.css) and the enter/exit motion is
 * reduce-motion aware via the `--transition-panel` token (collapsed by
 * tokens.css §5), so no literal colours, and no motion when the OS forbids it.
 */
@Component({
  selector: 'app-toast-host',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="toast-host">
      @for (t of notify.toasts(); track t.id) {
        <div
          class="toast"
          [class.leaving]="t.leaving"
          [attr.data-severity]="t.severity"
          [attr.role]="t.assertive ? 'alert' : 'status'"
          [attr.aria-atomic]="true"
        >
          <span class="toast-accent" aria-hidden="true"></span>
          <div class="toast-body">
            <strong class="toast-title">{{ t.title }}</strong>
            <span class="toast-text">{{ t.body }}</span>
          </div>
          <button type="button" class="toast-close" (click)="notify.dismiss(t.id)" aria-label="Dismiss notification">
            <span aria-hidden="true">&times;</span>
          </button>
        </div>
      }
    </div>
  `,
  styleUrl: './toast-host.component.css',
})
export class ToastHostComponent {
  readonly notify = inject(NotificationService);
}
