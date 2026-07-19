import { DestroyRef, Directive, EmbeddedViewRef, Input, TemplateRef, ViewContainerRef, inject } from '@angular/core';
import { readPanelMotion } from './panel-motion';

type Phase = 'closed' | 'entering' | 'open' | 'exiting';

/**
 * P1-06.6 — the reusable "wow" beat (SPEC §9.6): a *structural* directive that
 * mounts its content with an enter transition when its input turns truthy and
 * plays an exit transition — then unmounts — when it turns falsy. It is the
 * general-purpose extraction of the phase machine baked into
 * `shared/panel-dock/panel-dock.component.ts`, so the panel-dock (and any future
 * skill panel) can adopt one attribute instead of re-implementing it:
 *
 *     <div *appPanelTransition="skillEnabled()" class="panel">…</div>
 *
 * Design notes:
 *  - It animates GPU-cheap `opacity` + `transform` only (never layout), applied
 *    as inline styles, so it needs no global stylesheet and drops onto any host.
 *    (A layout-collapsing variant — animating width — remains the job of the
 *    existing PanelDockComponent; this primitive stays composable.)
 *  - Timing + easing come from the motion tokens via `readPanelMotion()`, and
 *    OS "reduce motion" is honored through `shared/motion.ts`: when set, the
 *    animation is *suppressed entirely* (instant mount / instant unmount), which
 *    both satisfies the accessibility contract (§8.6) and avoids a 0ms flash.
 *  - Rapid enable/disable toggling is safe: every state change first cancels any
 *    pending rAF and unmount timer, and the phase machine reconciles from
 *    whatever state it is in (e.g. re-opening mid-exit reverses in place rather
 *    than tearing down a live view).
 *
 * `@angular/animations` is intentionally NOT used — it is not a dependency of
 * this client (see client/web/package.json) and would require a provider; the
 * CSS-transition approach here matches the existing PanelDock and needs neither.
 */
@Directive({
  selector: '[appPanelTransition]',
  standalone: true,
})
export class PanelTransitionDirective {
  private readonly tpl = inject(TemplateRef);
  private readonly vcr = inject(ViewContainerRef);

  private view: EmbeddedViewRef<unknown> | null = null;
  private host: HTMLElement | null = null;
  private phase: Phase = 'closed';
  private removeTimer: ReturnType<typeof setTimeout> | null = null;
  private rafId: number | null = null;
  private firstRun = true;

  /** Transform offset the panel travels over (default: slides in from the right). */
  private offset = '8px';
  /** Scale the panel grows from while entering. */
  private scaleFrom = 0.98;
  /** Animate the very first mount too (default true, matching PanelDock). */
  private appear = true;

  @Input('appPanelTransitionOffset') set offsetInput(value: string | null | undefined) {
    if (value) this.offset = value;
  }
  @Input('appPanelTransitionScale') set scaleInput(value: number | null | undefined) {
    if (typeof value === 'number' && !Number.isNaN(value)) this.scaleFrom = value;
  }
  @Input('appPanelTransitionAppear') set appearInput(value: boolean | null | undefined) {
    this.appear = value !== false;
  }

  /** The open/enabled state. Truthy → mount + enter; falsy → exit + unmount. */
  @Input({ required: true, alias: 'appPanelTransition' }) set open(value: boolean | null | undefined) {
    if (value) this.mount();
    else this.unmount();
  }

  constructor() {
    inject(DestroyRef).onDestroy(() => this.teardown());
  }

  // ── enter ────────────────────────────────────────────────────────────────

  private mount(): void {
    this.cancelPending();
    // Already open or already heading open — nothing to do.
    if (this.phase === 'open' || this.phase === 'entering') return;

    const motion = readPanelMotion();
    const resuming = this.phase === 'exiting'; // a live, mid-exit view we can reverse

    if (!this.view) {
      // A structural directive renders by INSERTING the template into its own
      // view container (creating a detached view via TemplateRef would never
      // reach the DOM). detectChanges() flushes it so the host exists to animate.
      this.view = this.vcr.createEmbeddedView(this.tpl);
      this.view.detectChanges();
      this.host = firstElement(this.view);
    }

    const host = this.host;
    const skipAnim = motion.reduced || (this.firstRun && !this.appear);
    this.firstRun = false;

    // No animatable host element (e.g. a text/comment root) or motion suppressed:
    // just show it.
    if (!host || skipAnim) {
      if (host) clearInlineMotion(host);
      this.phase = 'open';
      return;
    }

    if (resuming) {
      // View is already on screen mid-exit; transition straight back to shown.
      setShown(host, motion);
      this.phase = 'open';
      return;
    }

    // Fresh mount: commit the hidden start state, force a reflow so it is the
    // real starting point, then flip to shown on the next painted frame.
    setHidden(host, motion, this.offset, this.scaleFrom);
    reflow(host);
    this.phase = 'entering';
    this.rafId = raf(() =>
      (this.rafId = raf(() => {
        this.rafId = null;
        if (!this.view || this.phase !== 'entering') return;
        setShown(host, motion);
        this.phase = 'open';
      }))
    );
  }

  // ── exit ─────────────────────────────────────────────────────────────────

  private unmount(): void {
    this.cancelPending();
    // Nothing mounted, or already leaving.
    if (this.phase === 'closed' || this.phase === 'exiting') return;

    const motion = readPanelMotion();
    const host = this.host;

    if (!host || motion.reduced) {
      this.destroyView();
      return;
    }

    setHidden(host, motion, this.offset, this.scaleFrom);
    this.phase = 'exiting';
    this.removeTimer = setTimeout(() => {
      this.removeTimer = null;
      this.destroyView();
    }, motion.durationMs);
  }

  // ── lifecycle helpers ──────────────────────────────────────────────────────

  /** Clears any scheduled frame / removal WITHOUT changing phase or the view. */
  private cancelPending(): void {
    if (this.rafId !== null) {
      caf(this.rafId);
      this.rafId = null;
    }
    if (this.removeTimer !== null) {
      clearTimeout(this.removeTimer);
      this.removeTimer = null;
    }
  }

  private destroyView(): void {
    if (this.view) {
      try {
        this.vcr.clear(); // exactly one view lives here — clears + removes its DOM
      } catch {
        /* container already torn down by the framework — ignore */
      }
    }
    this.view = null;
    this.host = null;
    this.phase = 'closed';
  }

  private teardown(): void {
    this.cancelPending();
    this.destroyView();
  }
}

// ── module-scope DOM helpers (kept pure + guarded so the directive body reads
//    as a state machine) ──────────────────────────────────────────────────────

function firstElement(view: EmbeddedViewRef<unknown>): HTMLElement | null {
  for (const node of view.rootNodes as Node[]) {
    if (node && node.nodeType === Node.ELEMENT_NODE) return node as HTMLElement;
  }
  return null;
}

function transitionFor(motion: { durationMs: number; easing: string }): string {
  const d = `${motion.durationMs}ms`;
  return `opacity ${d} ${motion.easing}, transform ${d} ${motion.easing}`;
}

function setHidden(host: HTMLElement, motion: { durationMs: number; easing: string }, offset: string, scale: number): void {
  host.style.transition = transitionFor(motion);
  host.style.opacity = '0';
  host.style.transform = `translateX(${offset}) scale(${scale})`;
}

function setShown(host: HTMLElement, motion: { durationMs: number; easing: string }): void {
  host.style.transition = transitionFor(motion);
  host.style.opacity = '1';
  host.style.transform = 'none';
}

function clearInlineMotion(host: HTMLElement): void {
  host.style.transition = '';
  host.style.opacity = '';
  host.style.transform = '';
}

/** Reading a layout property flushes pending style changes so the next paint animates from them. */
function reflow(host: HTMLElement): void {
  void host.offsetWidth;
}

function raf(cb: () => void): number {
  return typeof requestAnimationFrame !== 'undefined'
    ? requestAnimationFrame(cb)
    : (setTimeout(cb, 16) as unknown as number);
}

function caf(id: number): void {
  if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(id);
  else clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
}
