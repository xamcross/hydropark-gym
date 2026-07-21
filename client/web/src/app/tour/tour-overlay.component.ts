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
import { TourService } from './tour.service';
import { TOUR_STEPS } from './tour.model';

interface Rect { top: number; left: number; width: number; height: number; }

/**
 * TOUR OVERLAY — the first-run spotlight surface. Dims the shell, highlights the
 * current feature's anchor with a padded "ring" (a box-shadow scrim), and shows a
 * tooltip dialog beside it. Repositions on resize/scroll and when the anchor
 * mounts/unmounts. Full keyboard + ARIA; reduced-motion aware via CSS.
 */
@Component({
  selector: 'app-tour-overlay',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './tour-overlay.component.html',
  styleUrl: './tour-overlay.component.css',
})
export class TourOverlayComponent {
  readonly tour = inject(TourService);
  readonly totalSteps = TOUR_STEPS.length;

  readonly titleId = 'tour-step-title';
  readonly descId = 'tour-step-desc';
  private readonly dialogEl = viewChild<ElementRef<HTMLElement>>('dialog');
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');

  /** The measured anchor rect (viewport coords), or null when unanchored → centered tooltip. */
  private readonly _rect = signal<Rect | null>(null);
  readonly rect = this._rect.asReadonly();
  readonly ringStyle = computed(() => {
    const r = this._rect();
    if (!r) return null;
    const pad = 6;
    return {
      top: `${r.top - pad}px`,
      left: `${r.left - pad}px`,
      width: `${r.width + pad * 2}px`,
      height: `${r.height + pad * 2}px`,
    };
  });
  /** Tooltip placement: below the ring, or centered when unanchored. */
  readonly tooltipStyle = computed(() => {
    const r = this._rect();
    if (!r) return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };
    const belowTop = r.top + r.height + 14;
    const placeAbove = belowTop + 180 > window.innerHeight; // rough tooltip height budget
    const top = placeAbove ? Math.max(12, r.top - 14 - 180) : belowTop;
    const left = Math.min(Math.max(12, r.left), window.innerWidth - 340);
    return { top: `${top}px`, left: `${left}px`, transform: 'none' };
  });

  readonly isMagic = computed(() => this.tour.step().advance === 'magic');

  private ro: ResizeObserver | null = null;
  private rafId = 0;
  private readonly onWindowChange = () => this.scheduleMeasure();

  constructor() {
    // (Re)attach observers + measure whenever the tour opens or the step changes.
    effect(() => {
      const active = this.tour.active();
      const anchor = this.tour.currentAnchor(); // register dependency
      this.teardownObservers();
      if (!active) { this._rect.set(null); return; }
      this.measure();
      if (anchor) {
        this.ro = new ResizeObserver(() => this.scheduleMeasure());
        this.ro.observe(anchor);
      }
      window.addEventListener('resize', this.onWindowChange, { passive: true });
      window.addEventListener('scroll', this.onWindowChange, { passive: true, capture: true });
      // Move focus to the new step's heading (screen-reader lands on the title).
      setTimeout(() => this.heading()?.nativeElement.focus(), 0);
    });
  }

  private scheduleMeasure(): void {
    cancelAnimationFrame(this.rafId);
    this.rafId = requestAnimationFrame(() => this.measure());
  }
  private measure(): void {
    const el = this.tour.currentAnchor();
    if (!el) { this._rect.set(null); return; }
    const r = el.getBoundingClientRect();
    this._rect.set({ top: r.top, left: r.left, width: r.width, height: r.height });
  }
  private teardownObservers(): void {
    this.ro?.disconnect(); this.ro = null;
    cancelAnimationFrame(this.rafId);
    window.removeEventListener('resize', this.onWindowChange);
    window.removeEventListener('scroll', this.onWindowChange, { capture: true } as any);
  }

  // --- controls ------------------------------------------------------------

  send(): void { void this.tour.fireSuggestedSend(); }
  next(): void { this.tour.next(); }
  back(): void { this.tour.back(); }
  skip(): void { this.tour.skip(); }

  onKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'Escape': event.preventDefault(); this.skip(); break;
      case 'Enter':
      case 'ArrowRight': event.preventDefault(); this.next(); break;
      case 'ArrowLeft':
      case 'Backspace': event.preventDefault(); this.back(); break;
      case 'Tab': this.trapTab(event); break;
    }
  }

  private trapTab(event: KeyboardEvent): void {
    const root = this.dialogEl()?.nativeElement;
    if (!root) return;
    const nodes = Array.from(
      root.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])')
    ).filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (nodes.length === 0) return;
    const first = nodes[0], last = nodes[nodes.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
  }
}
