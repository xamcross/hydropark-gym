/* =============================================================================
   HYDROPARK — BASE WIDGET CONTRACT  (P1-06.1 · SPEC §9.2/§9.3/§8.3.4/§9.8)
   -----------------------------------------------------------------------------
   The ONE contract every widget in the v1 library (SPEC §9.4, the ~12 types)
   obeys, expressed as TypeScript. It mirrors `contracts/widgets/_widget-contract.md`:
   the typed props/state surface (§2), the loading/empty/error state machine (§6),
   the four-direction binding hooks + the event contract (§3/§4), the read-only
   bound-state shape a non-writer receives (§5), and the accepted slot kinds (§9).

   This is the language the per-widget contracts (P1-06.4a–.4l) are authored in
   and the shape the composed-panel-host's bound-state runtime (`composition/
   bound-state.ts`) delivers. It is framework-agnostic — nothing here imports
   Angular — so it is equally the contract the renderer, the merge layer, and the
   certification pipeline reason about.
   ============================================================================= */

import { SlotKind } from '../shared/bus';

// ---------------------------------------------------------------------------
// §6 — the mandatory lifecycle state machine (loading / empty / error + …)
// ---------------------------------------------------------------------------

/**
 * The lifecycle state a widget's runtime is in. `loading`/`empty`/`error` are
 * the three MANDATORY data states every widget implements (contract §6, verified
 * by the X-A11Y + certification gates); `ready` is the transient "bound, about to
 * resolve to empty|populated" state; `readonly` is the §5 non-writer view; and
 * `placeholder` is the terminal §11 unknown/too-new degrade. A skill may override
 * the loading/empty/error COPY (via `states`) but can never suppress a state.
 */
export type WidgetLifecycle =
  | 'loading'
  | 'ready'
  | 'empty'
  | 'populated'
  | 'error'
  | 'readonly'
  | 'placeholder';

/** The closed set of lifecycle states, for exhaustiveness checks / iteration. */
export const WIDGET_LIFECYCLE_STATES: readonly WidgetLifecycle[] = [
  'loading',
  'ready',
  'empty',
  'populated',
  'error',
  'readonly',
  'placeholder',
] as const;

/**
 * Skill-overridable COPY for the three data states (contract §6 — copy only,
 * never behaviour). Every field is optional; an omitted string falls back to the
 * widget-type default. Localizable.
 */
export interface WidgetStatesCopy {
  loading?: string;
  empty?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// §3/§4 — the event contract + the four binding directions
// ---------------------------------------------------------------------------

/**
 * One event a widget posts to the bus (contract §3 `emits`). `to_chat` decides
 * whether the event appends a system line to the transcript; `time_critical`
 * additionally fires the OS notification (SPEC §9.7). Certification rejects
 * duplicate event names within one widget.
 */
export interface WidgetEventDecl {
  name: string;
  to_chat: boolean;
  time_critical?: boolean;
}

/**
 * The binding hooks a widget declares (contract §4), keyed on slot/tool NAME —
 * routing is never guessed from field names.
 */
export interface WidgetBindings {
  /** The primary slot this widget renders and (when writer-of-record) edits. */
  binds_state?: string;
  /** Extra slots observed READ-ONLY for display; any update re-renders the widget. */
  reads_state?: readonly string[];
  /** The tool a user action invokes via the deterministic UI-first path (dir 2). */
  binds_tool?: string;
}

// ---------------------------------------------------------------------------
// §5 — read-only bound state (writer-of-record), resolved at merge
// ---------------------------------------------------------------------------

/**
 * The read-only-aware bound state a widget receives for its `binds_state` slot
 * (contract §5). Resolved at MERGE and delivered to the widget as runtime state
 * — never authored in the manifest. The bound-state runtime
 * (`composition/bound-state.ts`) computes it from the live slot + the panel's
 * owning skill; the composed-panel-host feeds it to bound-aware widgets.
 *
 * A widget that receives a `BoundState` MUST (contract §5):
 *   1. render LIVE — reflect every slot update in real time;
 *   2. when `readonly`, disable ALL edit affordances (visually + `disabled`/
 *      `aria-disabled`); and
 *   3. NAME the owner — expose "Managed by {writer}" as a tooltip / accessible
 *      description so the user knows where edits go.
 */
export interface BoundState<V = unknown> {
  /** The bound slot name. */
  slot: string;
  /** The slot's kind (`scalar` | `list` | `record`). */
  kind: SlotKind;
  /** The live slot value the widget renders (undefined until first populated). */
  value: V | undefined;
  /** Monotonic slot version — bumps on every accepted mutation (bus contract §1.3). */
  version: number;
  /** True when the owning skill is NOT the slot's writer-of-record → read-only (§5). */
  readonly: boolean;
  /** Writer-of-record skill id (the slot owner), or null when unowned. */
  writerId: string | null;
  /** Human display name of the writer-of-record, for the "Managed by …" affordance. */
  writer: string | null;
}

// ---------------------------------------------------------------------------
// §9 — accepted slot kinds for a widget's `binds_state`
// ---------------------------------------------------------------------------

/** The slot kind(s) a widget type accepts for `binds_state` (contract §9 fit). */
export type AcceptsSlotKind = SlotKind | readonly SlotKind[];

// ---------------------------------------------------------------------------
// The base contract every v1 widget obeys (P1-06.1)
// ---------------------------------------------------------------------------

/**
 * The base widget contract (`_widget-contract.md`). Generic over a widget type's
 * typed PROPS (authored, immutable-per-instance config — §2) and typed runtime
 * STATE (the live data owned by the core; the webview renders a projection — §2).
 * The per-widget contracts (P1-06.4x) specialise `Props`/`State`/`EventName` and
 * pin `type`.
 *
 * A widget is DECLARATION ONLY (§1): it never ships HTML/JS/CSS; the first-party
 * renderer draws it. The model can change a widget only by calling a tool or
 * writing a slot — never by emitting UI code (§3 "Model ↔ UI bridge").
 */
export interface WidgetContract<
  Props = Record<string, unknown>,
  State = unknown,
  EventName extends string = string,
> {
  /** Which library widget renders this panel (contract §1 `type`; not a closed enum). */
  readonly type: string;
  /** Authored, immutable-per-instance configuration (contract §2). */
  readonly props: Props;
  /** Live runtime state the widget renders — a projection of the core's store (contract §2). */
  readonly state: State;
  /** The lifecycle state the runtime state is currently in (contract §6). */
  readonly lifecycle: WidgetLifecycle;
  /** The events this widget posts to the bus (contract §3). */
  readonly events: readonly WidgetEventDecl[];
  /** The declared binding hooks (contract §4). */
  readonly bindings: WidgetBindings;
  /** The slot kind(s) this widget accepts for `binds_state` (contract §9). */
  readonly acceptsSlotKind?: AcceptsSlotKind;
  /** The read-only bound state when this widget binds a slot it does not own (contract §5). */
  readonly bound?: BoundState<State> | null;
}

/**
 * Derive the lifecycle state from the primitive signals every widget already
 * has. A shared helper so the twelve widgets classify their state identically
 * (contract §6): error wins, then loading, then read-only, then empty vs
 * populated. `placeholder` is decided upstream by the registry, not here.
 */
export function lifecycleOf(input: {
  loading?: boolean;
  error?: boolean;
  readonly?: boolean;
  hasData: boolean;
}): WidgetLifecycle {
  if (input.error) return 'error';
  if (input.loading) return 'loading';
  if (input.readonly) return 'readonly';
  return input.hasData ? 'populated' : 'empty';
}
