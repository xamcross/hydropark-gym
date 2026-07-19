import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  afterNextRender,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { IPC_PORT } from '../../ipc/ipc.port';

type Phase = 'loading' | 'ready' | 'error';

/**
 * Install-time capability disclosure dialog — "This skill can: …" (SPEC §8.5 /
 * §11, the B4 trust surface). `SkillDetailComponent` opens this BEFORE an
 * install/buy proceeds: {@link capabilities} (the skill's derived §8.5
 * capability tokens, e.g. `["timers","list_management"]`, see
 * `catalog.model.ts#capabilitiesForTools`) drives a `capability_disclose` IPC
 * call whose plain-language result renders here.
 *
 * Confirm/Cancel are the only exits. Cancel (button, Escape, or backdrop
 * click) causes NO IPC call beyond the disclosure fetch itself and no state
 * change — the caller only proceeds with the real install/buy flow on Confirm.
 *
 * A11y + modal conventions pattern-matched from `SkillPreviewComponent`:
 * `role="dialog"` + `aria-modal`, labelled by its heading, Escape to close,
 * backdrop click to close, focus moved into the dialog on open.
 */
@Component({
  selector: 'app-capability-consent',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './capability-consent.component.html',
  styleUrl: './capability-consent.component.css',
})
export class CapabilityConsentComponent {
  private readonly ipc = inject(IPC_PORT);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** The skill's derived §8.5 capability tokens driving the disclosure fetch. */
  readonly capabilities = input.required<string[]>();
  /** Shown in the loading line only; purely cosmetic. */
  readonly skillName = input<string>('this skill');

  /** The shopper confirmed — the caller proceeds with the real install/buy flow. */
  readonly confirm = output<void>();
  /** Dismissed (Cancel / Escape / backdrop) — no side effects of any kind. */
  readonly cancel = output<void>();

  readonly phase = signal<Phase>('loading');
  readonly disclosure = signal<string | null>(null);
  readonly errorMsg = signal<string | null>(null);

  constructor() {
    effect(() => {
      const caps = this.capabilities();
      void this.load(caps);
    });
    // Move focus into the dialog once it has rendered (a11y).
    afterNextRender(() => {
      this.host.nativeElement.querySelector<HTMLElement>('.consent-dialog')?.focus();
    });
  }

  async load(capabilities: string[]): Promise<void> {
    this.phase.set('loading');
    this.errorMsg.set(null);
    try {
      const text = await this.ipc.invoke('capability_disclose', { capabilities });
      this.disclosure.set(text);
      this.phase.set('ready');
    } catch (e) {
      this.errorMsg.set(e instanceof Error ? e.message : String(e));
      this.phase.set('error');
    }
  }

  onConfirm(): void {
    this.confirm.emit();
  }

  onCancel(): void {
    this.cancel.emit();
  }

  /** Backdrop click (outside the dialog) cancels; clicks inside do not bubble here. */
  onBackdrop(event: MouseEvent): void {
    if (event.target === event.currentTarget) this.cancel.emit();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.cancel.emit();
  }
}
