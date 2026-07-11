import { PANEL_TRANSITION_MS, motionMs, prefersReducedMotion } from '../motion';

/**
 * Resolved motion parameters for a panel enter/exit beat, sourced from the
 * design-token vocabulary (styles/tokens.css §MOTION) so the transform beat
 * stays consistent with every other animated surface — and honors OS
 * "reduce motion" via the shared `shared/motion.ts` helper (P0-05.2 / SPEC §9.6).
 */
export interface PanelMotion {
  /** Effective duration in ms — already collapsed to 0 when reduce-motion is on. */
  readonly durationMs: number;
  /** Easing curve, read from the `--ease-out` token. */
  readonly easing: string;
  /** True when the OS asked us to minimise motion — callers skip the animation. */
  readonly reduced: boolean;
}

/** Mirrors `--ease-out` in tokens.css; used only if the token can't be read. */
const FALLBACK_EASING = 'cubic-bezier(0.16, 1, 0.3, 1)';

/** Reads a CSS custom property off `:root`, trimmed; '' when the DOM is unavailable. */
function readToken(name: string): string {
  if (typeof getComputedStyle === 'undefined' || typeof document === 'undefined') return '';
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  } catch {
    return '';
  }
}

/** Extracts the leading time value from a duration token like `"220ms var(--ease-out)"`. */
function parseLeadingMs(value: string, fallback: number): number {
  const ms = value.match(/([\d.]+)\s*ms/);
  if (ms) return Number(ms[1]);
  const s = value.match(/([\d.]+)\s*s(?![a-z])/i);
  if (s) return Number(s[1]) * 1000;
  return fallback;
}

/**
 * Snapshots the current panel-motion parameters. Called fresh on every
 * enter/exit so it reflects the live reduce-motion setting and any theme
 * token overrides in effect at that moment.
 */
export function readPanelMotion(): PanelMotion {
  const reduced = prefersReducedMotion();
  const rawMs = parseLeadingMs(readToken('--transition-panel'), PANEL_TRANSITION_MS);
  return {
    // motionMs() returns 0 under reduce-motion; otherwise the token duration.
    durationMs: motionMs(rawMs),
    easing: readToken('--ease-out') || FALLBACK_EASING,
    reduced,
  };
}
