import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { AuthService } from './auth.service';
import { AuthDialogComponent } from './auth-dialog.component';

/**
 * The topbar account affordance (P1-09.1). PROMPTS an account — never requires
 * one. Shows the current identity at a glance (Sign in / This device / email)
 * and opens the {@link AuthDialogComponent}, which it also hosts so a single
 * element in the shell provides the whole account surface. The dialog is a
 * fixed-position overlay, so mounting it here (in the header) is fine.
 */
@Component({
  selector: 'app-account-menu',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AuthDialogComponent],
  template: `
    <button
      type="button"
      class="account-btn"
      [class.on]="auth.hasIdentity()"
      (click)="open()"
      [attr.aria-haspopup]="'dialog'"
      [attr.aria-expanded]="auth.promptOpen()"
      [title]="titleText()"
    >
      <span class="account-glyph" aria-hidden="true">{{ auth.isAuthenticated() ? '●' : '○' }}</span>
      <span class="account-label">{{ label() }}</span>
    </button>

    <app-auth-dialog></app-auth-dialog>
  `,
  styleUrl: './account-menu.component.css',
})
export class AccountMenuComponent {
  readonly auth = inject(AuthService);

  readonly label = computed(() => {
    const email = this.auth.email();
    if (email) return email;
    switch (this.auth.status()) {
      case 'authenticated':
        return 'Account';
      case 'device':
        return 'This device';
      default:
        return 'Sign in';
    }
  });

  readonly titleText = computed(() =>
    this.auth.hasIdentity() ? 'Manage your account' : 'Sign in or create an account (optional)'
  );

  open(): void {
    this.auth.openPrompt('account');
  }
}
