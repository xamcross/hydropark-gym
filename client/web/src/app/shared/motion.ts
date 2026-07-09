/** Matches --transition-panel in styles.css. Kept as a JS constant because the
 *  enter/exit unmount timing (panel-dock.component.ts) needs a concrete number
 *  to schedule DOM removal after, not just a CSS duration. */
export const PANEL_TRANSITION_MS = 240;

export function prefersReducedMotion(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Honors OS "reduce motion" (P0-05.2): collapses any scheduled animation delay to ~0. */
export function motionMs(normalMs: number): number {
  return prefersReducedMotion() ? 0 : normalMs;
}
