import { ChangeDetectionStrategy, Component, Inject, OnInit, computed, signal } from '@angular/core';
import { IPC_PORT, IpcPort } from '../ipc/ipc.port';
import { UpdateCheckResult } from '../ipc/contract';

/**
 * APP AUTO-UPDATE SURFACE (P1-11.2) — the small topbar affordance that calls the
 * Rust `check_for_update` command (which owns `tauri-plugin-updater`) and renders
 * its typed status: "Up to date" / "Update available" / "Updating…".
 *
 * It fires one non-blocking check at startup and re-checks on click. It is
 * deliberately quiet: it never renders an error banner and never blocks anything.
 *
 * OFFLINE-SAFE (§18): the command itself already folds every failure (offline, an
 * unreachable endpoint, or the PLACEHOLDER endpoint/pubkey that ships until the
 * update server + signing key are provisioned — the release GATE) into
 * `phase: 'error'` rather than rejecting; this component ALSO swallows any thrown
 * transport error, so a failed check leaves the button as a plain "Check for
 * updates" and can never interrupt a fully-offline session.
 *
 * Accessibility: state is carried by explicit TEXT (never colour alone, WCAG 1.4.1);
 * the label region is `aria-live="polite"` so the outcome is announced. OnPush + signals.
 */
@Component({
  selector: 'app-update-check',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      class="update-btn"
      [class.has-update]="hasUpdate()"
      [disabled]="checking()"
      (click)="check()"
      [title]="titleText()"
    >
      <span class="update-glyph" aria-hidden="true">{{ glyph() }}</span>
      <span class="update-label" aria-live="polite">{{ label() }}</span>
    </button>
  `,
  styleUrl: './update-check.component.css',
})
export class UpdateCheckComponent implements OnInit {
  private readonly _result = signal<UpdateCheckResult | null>(null);
  private readonly _checking = signal<boolean>(false);

  readonly checking = this._checking.asReadonly();

  /** A newer signed build is available — drives the accent styling + the ⬆ glyph. */
  readonly hasUpdate = computed(() => this._result()?.phase === 'updateAvailable');
  private readonly busy = computed(() => this._checking() || this._result()?.phase === 'downloading');

  readonly label = computed(() => {
    if (this._checking()) return 'Checking…';
    const r = this._result();
    if (!r) return 'Check for updates';
    switch (r.phase) {
      case 'upToDate':
        return 'Up to date';
      case 'updateAvailable':
        return 'Update available';
      case 'downloading':
        return 'Updating…';
      case 'error':
      default:
        // Silent on failure (§18): fall back to the neutral call-to-action.
        return 'Check for updates';
    }
  });

  readonly glyph = computed(() => {
    if (this.busy()) return '↻';
    if (this.hasUpdate()) return '⬆';
    if (this._result()?.phase === 'upToDate') return '✓';
    return '⟳';
  });

  readonly titleText = computed(() => {
    const r = this._result();
    if (r?.phase === 'updateAvailable') {
      const notes = r.notes ? ` — ${r.notes}` : '';
      return `Version ${r.availableVersion} is available (you have ${r.currentVersion})${notes}`;
    }
    if (r?.phase === 'upToDate') return `You're on the latest version (${r.currentVersion})`;
    if (r?.phase === 'downloading') return `Downloading version ${r.availableVersion}…`;
    return 'Check for updates';
  });

  constructor(@Inject(IPC_PORT) private readonly ipc: IpcPort) {}

  ngOnInit(): void {
    // Fire-and-forget check at startup — never awaited, never blocks boot (§18).
    void this.check();
  }

  async check(): Promise<void> {
    if (this._checking()) return;
    this._checking.set(true);
    try {
      const result = await this.ipc.invoke('check_for_update', undefined);
      this._result.set(result);
    } catch {
      // NON-BLOCKING (§18): the command is designed never to reject, but if the
      // transport itself throws (e.g. the mock has no handler) we swallow it and
      // keep the last-known state — an update check must never break offline use.
    } finally {
      this._checking.set(false);
    }
  }
}
