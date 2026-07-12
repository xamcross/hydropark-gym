/* =============================================================================
   HYDROPARK — HARDWARE TIER (pure)  ·  P1-11.4 first-run onboarding (SPEC §16.1)
   -----------------------------------------------------------------------------
   Turns the read-only {@link HardwareProfile} (P0-02.3) into an HONEST, human
   verdict for the onboarding "hardware check" step: a coarse tier, an ESTIMATED
   tok/s range for the bundled 3B model, and a plain-language speed note.

   Contract (matches the P0-02.3 promise): this is a covariate the UI *shows*,
   never a gate — no tier blocks a feature. The numbers are deliberately framed
   as estimates; the real rate is measured live as the user chats (the chat
   footer's `tok/s`, fed by `inference://done`). The estimate anchors on the
   measured baseline for the bundled build (Qwen2.5-3B Q4_K_M on CPU ≈ mid-teens
   to low-20s tok/s on an 8-core desktop), so we neither over- nor under-promise.

   No Angular import — deterministic + unit-testable in isolation. */

import { HardwareProfile } from '../ipc/contract';

export type HardwareTier = 'comfortable' | 'workable' | 'constrained' | 'unknown';

/** A rendered hardware verdict — every field is presentation-ready (no template math). */
export interface HardwareVerdict {
  readonly tier: HardwareTier;
  /** Short human label, e.g. "Comfortable". */
  readonly label: string;
  /** Estimated tok/s band for the bundled 3B model, or null when unknown. */
  readonly tokRange: readonly [number, number] | null;
  /** Presentation string for the band, e.g. "~15–25 tok/s (estimated)". '' when unknown. */
  readonly rangeText: string;
  /** One honest sentence about expected feel. */
  readonly speedNote: string;
  /** What drove the tier (the covariates we read). */
  readonly detail: string;
  /** Maps to a `--tone-*` role for the chip (never hue-only — always paired with the label). */
  readonly tone: 'fine' | 'careful';
}

/** Below this the CPU path on the bundled build starts to feel sluggish (honest heuristic). */
const CORES_COMFORTABLE = 8;
const CORES_WORKABLE = 4;
const RAM_COMFORTABLE_GB = 16;
const RAM_WORKABLE_GB = 8;

/**
 * Classify a hardware profile into a tier + estimated speed for the BUNDLED 3B
 * model. CPU-first on purpose: the bundled llama.cpp build runs on CPU today, so
 * the estimate is CPU-based and a detected GPU is surfaced as "not used yet"
 * rather than inflating the number (staying honest — SPEC §16.1).
 */
export function estimateHardware(profile: HardwareProfile | null | undefined): HardwareVerdict {
  if (!profile) {
    return {
      tier: 'unknown',
      label: 'Checking…',
      tokRange: null,
      rangeText: '',
      speedNote: 'Reading your CPU and memory to estimate on-device speed.',
      detail: 'Hardware profile not available yet.',
      tone: 'careful',
    };
  }

  const { cores, ram_gb, gpu_present } = profile;
  const gpuNote = gpu_present
    ? ' A GPU was detected, but the bundled build runs on CPU today, so this estimate is CPU-based.'
    : '';
  const detail = `${cores} logical core${cores === 1 ? '' : 's'} · ${round1(ram_gb)} GB RAM · ${
    gpu_present ? 'GPU present (CPU inference for now)' : 'no discrete GPU'
  }`;

  if (cores >= CORES_COMFORTABLE && ram_gb >= RAM_COMFORTABLE_GB) {
    return verdict('comfortable', 'Comfortable', [15, 25], 'fine',
      'Your machine should run the on-device model at a comfortable, conversational pace.' + gpuNote,
      detail);
  }

  if (cores >= CORES_WORKABLE && ram_gb >= RAM_WORKABLE_GB) {
    return verdict('workable', 'Workable', [8, 16], 'fine',
      'The on-device model will run at a usable pace — replies stream steadily rather than instantly.' + gpuNote,
      detail);
  }

  return verdict('constrained', 'Constrained', [3, 8], 'careful',
    'The on-device model will run, but expect slower, more deliberate replies on this hardware.' + gpuNote,
    detail);
}

function verdict(
  tier: HardwareTier,
  label: string,
  tokRange: [number, number],
  tone: 'fine' | 'careful',
  speedNote: string,
  detail: string
): HardwareVerdict {
  return { tier, label, tokRange, rangeText: `~${tokRange[0]}–${tokRange[1]} tok/s (estimated)`, speedNote, detail, tone };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
