import { Component, effect, input, signal } from '@angular/core';
import { motionMs, PANEL_TRANSITION_MS } from '../motion';

type Phase = 'closed' | 'entering' | 'open' | 'exiting';

/**
 * The H1 "wow" payload (SPEC §9.6 / PHASE0-PLAN §3.4, P0-05.2): animates its
 * projected content in when `open` becomes true and out when it becomes
 * false, instead of an instant mount/unmount. Honors OS "reduce motion" —
 * see `shared/motion.ts` — by collapsing the timeout that gates DOM removal
 * to ~0ms, matching the CSS media query in styles.css that flattens the
 * transition duration itself.
 *
 * A reusable wrapper (rather than baking this into app.component) so any
 * future skill's panels get the same transform for free.
 */
@Component({
  selector: 'app-panel-dock',
  standalone: true,
  template: `
    @if (phase() !== 'closed') {
      <div class="dock" [class]="'phase-' + phase()">
        <ng-content></ng-content>
      </div>
    }
  `,
  styleUrl: './panel-dock.component.css',
})
export class PanelDockComponent {
  readonly open = input.required<boolean>();

  readonly phase = signal<Phase>('closed');
  private closeTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    effect(() => {
      const isOpen = this.open();
      if (this.closeTimeout) {
        clearTimeout(this.closeTimeout);
        this.closeTimeout = null;
      }
      if (isOpen) {
        this.phase.set('entering');
        // Double rAF: guarantees the browser paints the "entering" (hidden)
        // state at least once before we flip to "open", so the CSS
        // transition has a real starting point to animate from.
        requestAnimationFrame(() => requestAnimationFrame(() => this.phase.set('open')));
      } else {
        if (this.phase() === 'closed') return;
        this.phase.set('exiting');
        this.closeTimeout = setTimeout(() => this.phase.set('closed'), motionMs(PANEL_TRANSITION_MS));
      }
    });
  }
}
