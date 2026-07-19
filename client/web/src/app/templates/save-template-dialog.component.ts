import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  afterNextRender,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CompositionService } from '../composition/composition.service';
import { TemplateView } from '../ipc/contract';
import { TemplatesService } from './templates.service';

/**
 * "Save as template" dialog (Task 11b, SPEC §10). Captures the CURRENT
 * composed combo (whatever `CompositionService.enabledManifests()` reports
 * right now) under a name the user picks; `TemplatesService.save()` owns the
 * actual IPC call, the layout snapshot, the gallery refresh, and the success
 * toast — this component is purely the name-entry form + validation.
 *
 * Same modal conventions as `capability-consent.component.ts` (the newest
 * precedent): `role="dialog"` + `aria-modal`, Escape/backdrop to cancel,
 * focus moved into the dialog on open.
 */
@Component({
  selector: 'app-save-template-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  templateUrl: './save-template-dialog.component.html',
  styleUrl: './save-template-dialog.component.css',
})
export class SaveTemplateDialogComponent {
  private readonly composition = inject(CompositionService);
  private readonly templatesSvc = inject(TemplatesService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** Saved successfully — the caller (the composed-panel host) closes the dialog. */
  readonly saved = output<TemplateView>();
  /** Dismissed (Cancel / Escape / backdrop) — no side effects. */
  readonly cancel = output<void>();

  readonly name = signal('');
  readonly submitting = signal(false);
  readonly errorMsg = signal<string | null>(null);

  /** What this save will actually capture — shown so the user knows what they're naming. */
  readonly skillNames = computed(() => this.composition.enabledManifests().map((m) => m.name));

  constructor() {
    afterNextRender(() => {
      this.host.nativeElement.querySelector<HTMLElement>('.save-tmpl-name')?.focus();
    });
  }

  async onSubmit(): Promise<void> {
    const trimmed = this.name().trim();
    if (!trimmed) {
      this.errorMsg.set('Give the template a name.');
      return;
    }
    this.errorMsg.set(null);
    this.submitting.set(true);
    try {
      const view = await this.templatesSvc.save(trimmed);
      this.saved.emit(view);
    } catch (e) {
      this.errorMsg.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.submitting.set(false);
    }
  }

  onCancel(): void {
    this.cancel.emit();
  }

  onBackdrop(event: MouseEvent): void {
    if (event.target === event.currentTarget) this.cancel.emit();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.cancel.emit();
  }
}
