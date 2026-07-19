/* =============================================================================
   HYDROPARK — BOUND-STATE RUNTIME  (P1-06.1 · SPEC §9.3 #1/#2, §8.3.4 · contract §5)
   -----------------------------------------------------------------------------
   The read-only-bound-state runtime the composed-panel-host feeds to a widget so
   a NON-WRITER renders LIVE (read-only) with its edit affordances disabled and a
   tooltip naming the writer-of-record skill (contract §5).

   A widget's `binds_state` is two-way ONLY if its owning skill is the slot's
   writer-of-record (the first enabled skill that declared the slot `read_write`,
   SPEC §8.3.4). Otherwise it binds READ-ONLY. This is resolved here from two
   inputs the host already has:
     - the LIVE slot state from the per-agent bus (`writerOfRecord` + `value` +
       `version` + `kind`); and
     - the panel's OWNING skill (`descriptor.ownerSkillId`, stamped by the
       manifest projection).

   Pure + Angular-free: given a slot snapshot it returns a plain {@link BoundState}
   — the host wraps the read in its OnPush template so the result stays live, and
   memoises it by version so the mounted widget's `bound` input reference is stable
   between change-detection passes.
   ============================================================================= */

import { SlotState } from '../shared/bus';
import { ArrangedPanel } from '../shared/layout/layout.model';
import { BoundState } from '../widgets/widget-contract';

/**
 * The NUL sentinel `bus.store` uses for an unowned slot's writer-of-record (a
 * value no real skill id can equal — see `bus.store.ts` `DEFAULT_DESCRIPTOR`).
 * A slot whose writer is this sentinel has no established owner yet.
 */
const UNOWNED_WRITER = ' ';

/**
 * Compute the read-only bound state for a panel that binds a slot (contract §5).
 *
 * `readonly` is TRUE when the slot has an established writer-of-record that is a
 * DIFFERENT skill than the one that authored this panel — i.e. this widget is a
 * live observer, not the editor. An unowned slot (NUL writer) is treated as not
 * read-only; a panel whose owner is unknown but bound to an owned slot is treated
 * as read-only (fail closed — never silently grant edit access to a slot this
 * panel can't prove it owns).
 *
 * Pure: takes the live slot snapshot explicitly; the host re-reads the slot
 * signal so the result re-renders on every mutation (direction #2 read side).
 */
export function boundStateFor<V = unknown>(
  panel: ArrangedPanel,
  slot: SlotState,
  displayNameOf: (skillId: string) => string
): BoundState<V> {
  const owner = panel.descriptor.ownerSkillId ?? null;
  const writerId =
    slot.writerOfRecord && slot.writerOfRecord !== UNOWNED_WRITER ? slot.writerOfRecord : null;
  const readonly = writerId !== null && writerId !== owner;
  return {
    slot: slot.slot,
    kind: slot.kind,
    value: slot.value as V | undefined,
    version: slot.version,
    readonly,
    writerId,
    writer: writerId ? displayNameOf(writerId) : null,
  };
}

/**
 * True when two bound states are equivalent for RENDER purposes — same slot
 * version, same read-only verdict, same writer, same value reference. The host
 * uses this to keep the `bound` input reference stable across change-detection
 * passes (the store only swaps a slot's value reference when it bumps the
 * version, so the version guard is sufficient; the extra checks are belt-and-
 * braces and catch a metadata-only refresh).
 */
export function boundStateEqual(a: BoundState | null, b: BoundState | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.slot === b.slot &&
    a.version === b.version &&
    a.readonly === b.readonly &&
    a.writerId === b.writerId &&
    a.value === b.value
  );
}
