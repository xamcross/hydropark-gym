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
import { CATALOG_PORT } from '../catalog.port';
import { PreviewPanel, SkillPreview } from '../catalog.model';

type Phase = 'loading' | 'ready' | 'error';

/**
 * Try-before-buy preview surface (SPEC §11.4, P1-08.4) — an accessible modal
 * dialog that shows a paid skill's DEMO PANELS and a CAPPED DEMO TRANSCRIPT.
 *
 * It is display-only: it fetches a {@link SkillPreview} (whose `no_purchase` is a
 * fixed `true`) and NEVER issues a license or unlocks anything. A persistent
 * "Preview — no purchase" banner makes that explicit. The single commerce
 * affordance is a Buy CTA that simply asks the host to run the normal purchase
 * flow; closing/escaping/back-drop all dismiss without side effects.
 *
 * A11y: `role="dialog"` + `aria-modal`, labelled by its heading, Escape to close,
 * backdrop click to close, and focus is moved into the dialog on open.
 */
@Component({
  selector: 'app-skill-preview',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './skill-preview.component.html',
  styleUrl: './skill-preview.component.css',
})
export class SkillPreviewComponent {
  private readonly port = inject(CATALOG_PORT);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly skillId = input.required<string>();
  /** Show the Buy CTA in the footer (paid + not yet owned). */
  readonly canBuy = input<boolean>(false);

  /** Dismiss the preview (no side effects). */
  readonly close = output<void>();
  /** The shopper chose to buy from the preview — the host runs the real flow. */
  readonly buy = output<void>();

  readonly phase = signal<Phase>('loading');
  readonly preview = signal<SkillPreview | null>(null);
  readonly errorMsg = signal<string | null>(null);

  /** Per-widget glyph for a demo panel tile — icon + label, never colour-only. */
  readonly panelGlyph = (p: PreviewPanel): string => PANEL_GLYPH[p.type] ?? '▦';

  constructor() {
    effect(() => {
      const id = this.skillId();
      void this.load(id);
    });
    // Move focus into the dialog once it has rendered (a11y).
    afterNextRender(() => {
      this.host.nativeElement.querySelector<HTMLElement>('.preview-dialog')?.focus();
    });
  }

  async load(id: string): Promise<void> {
    this.phase.set('loading');
    this.errorMsg.set(null);
    try {
      const preview = await this.port.getPreview(id);
      this.preview.set(preview);
      this.phase.set('ready');
    } catch (e) {
      this.errorMsg.set(e instanceof Error ? e.message : String(e));
      this.phase.set('error');
    }
  }

  onClose(): void {
    this.close.emit();
  }

  onBuy(): void {
    this.buy.emit();
  }

  /** Backdrop click (outside the dialog) closes; clicks inside do not bubble here. */
  onBackdrop(event: MouseEvent): void {
    if (event.target === event.currentTarget) this.close.emit();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.close.emit();
  }
}

/** Widget-type → tile glyph (paired with the panel label, so never colour-only). */
const PANEL_GLYPH: Record<string, string> = {
  timer_stack: '⏱',
  editable_list: '☑',
  table: '▦',
  segmented_toggle: '⇄',
  progress: '▮',
  key_value_panel: '▤',
  media_note: '❝',
  quick_actions: '⚡',
  slider_stepper: '⇕',
  date_time_picker: '📅',
  tabs: '❏',
};
