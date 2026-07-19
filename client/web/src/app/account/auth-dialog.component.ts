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
import { PurchaseService } from '../marketplace/purchase.service';
import { AuthService } from './auth.service';

type AuthMode = 'signin' | 'create';

/**
 * The login / register dialog (P1-09.1/.2) — the account affordance's surface.
 *
 * Self-gates on {@link AuthService.promptOpen}; rendered once in the shell so it
 * can be raised BOTH by the topbar account button (reason `account`) and by the
 * purchase gate (reason `purchase`). It PROMPTS, never forces: the app is fully
 * usable while anonymous, and the dialog always offers the no-email
 * "continue on this device" path so an account is genuinely optional.
 *
 * Adapts to identity state: the sign-in/create form, a step-up challenge input
 * (SPEC §13.4), or — once authenticated — an account panel with Restore
 * purchases + Sign out. OnPush + signals; full keyboard + ARIA (dialog role,
 * aria-modal, labelled by the live title, Tab focus trap, Escape to dismiss).
 */
@Component({
  selector: 'app-auth-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './auth-dialog.component.html',
  styleUrl: './auth-dialog.component.css',
})
export class AuthDialogComponent {
  readonly auth = inject(AuthService);
  readonly purchase = inject(PurchaseService);

  readonly titleId = 'auth-dialog-title';
  readonly descId = 'auth-dialog-desc';

  private readonly dialogEl = viewChild<ElementRef<HTMLElement>>('dialog');
  private readonly firstField = viewChild<ElementRef<HTMLElement>>('firstField');

  readonly mode = signal<AuthMode>('signin');
  readonly email = signal('');
  readonly password = signal('');
  readonly code = signal('');

  readonly emailValid = computed(() => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.email().trim()));
  readonly canSubmit = computed(() => {
    if (this.auth.busy()) return false;
    if (this.auth.stepUp()) return this.code().trim().length > 0;
    return this.emailValid() && this.password().length > 0;
  });

  /** Title reflects the current sub-state. */
  readonly title = computed(() => {
    if (this.auth.isAuthenticated()) return 'Your account';
    if (this.auth.stepUp()) return 'Verify it’s you';
    if (this.auth.promptReason() === 'purchase') return 'Sign in to buy';
    return this.mode() === 'create' ? 'Create your account' : 'Sign in';
  });

  constructor() {
    // Move focus into the dialog when it opens (and when the sub-state swaps the
    // fields out), deferred a tick so the branch content is in the DOM first.
    effect(() => {
      this.auth.promptOpen();
      this.auth.stepUp();
      this.auth.isAuthenticated();
      if (!this.auth.promptOpen()) return;
      setTimeout(() => this.firstField()?.nativeElement.focus(), 0);
    });
  }

  setMode(mode: AuthMode): void {
    this.mode.set(mode);
    this.auth.error.set(null);
  }

  onEmail(v: string): void {
    this.email.set(v);
  }
  onPassword(v: string): void {
    this.password.set(v);
  }
  onCode(v: string): void {
    this.code.set(v);
  }

  async submit(): Promise<void> {
    if (!this.canSubmit()) return;
    if (this.auth.stepUp()) {
      await this.auth.answerStepUp(this.code().trim());
      this.code.set('');
      return;
    }
    const ok =
      this.mode() === 'create'
        ? await this.auth.register(this.email().trim(), this.password())
        : await this.auth.login(this.email().trim(), this.password());
    if (ok) this.password.set('');
  }

  async continueOnDevice(): Promise<void> {
    await this.auth.ensureDevice();
  }

  async restore(): Promise<void> {
    await this.purchase.restore();
  }

  async signOut(): Promise<void> {
    await this.auth.logout();
  }

  close(): void {
    this.auth.closePrompt();
  }

  // --- keyboard: Escape dismisses, Tab is trapped inside the dialog --------

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
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
