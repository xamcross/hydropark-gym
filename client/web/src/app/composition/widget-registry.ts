/* =============================================================================
   HYDROPARK — WIDGET REGISTRY  (P1 live-flow wiring · SPEC §9.4/§9.5)
   -----------------------------------------------------------------------------
   The one place that maps a manifest's `panel.type` (widget-type name) to the
   concrete Angular component that renders it, plus the inputs to hand that
   component when mounted dynamically (via `NgComponentOutlet`) inside the
   layout-dock's projected panel body.

   Two families of widgets live here:
     • the P0 "skill" widgets (timer_stack / editable_list / segmented_toggle /
       chat) — SELF-SOURCING: they read `SessionService`/`ToolsService` directly
       and take no inputs, so they mount with `{}`;
     • the P1 library widgets (table, tabs, progress, key_value_panel, media_note,
       quick_actions, slider_stepper, date_time_picker) — previously built but
       UNMOUNTED. Registering them here is what makes the composed agent able to
       use them. They take contract-shaped inputs; until per-widget prop wiring
       lands (follow-up) they mount with safe defaults that satisfy their
       REQUIRED inputs so they render their own empty/loading state rather than
       throwing (NG0952).

   NgComponentOutlet's `inputs` binding is `Record<string, unknown>`, so this
   registry is deliberately type-erased at the mount boundary — which is what
   keeps the host template `strictTemplates`-clean without a giant typed switch.
   ============================================================================= */

import { Type } from '@angular/core';
import { ArrangedPanel } from '../shared/layout/layout.model';

import { ChatComponent } from '../widgets/chat/chat.component';
import { TimerStackComponent } from '../widgets/timer-stack/timer-stack.component';
import { EditableListComponent } from '../widgets/editable-list/editable-list.component';
import { SegmentedToggleComponent } from '../widgets/segmented-toggle/segmented-toggle.component';
import { TableComponent } from '../widgets/table/table.component';
import { TabsComponent } from '../widgets/tabs/tabs.component';
import { ProgressComponent } from '../widgets/progress/progress.component';
import { KeyValuePanelComponent } from '../widgets/key-value-panel/key-value-panel.component';
import { MediaNoteComponent } from '../widgets/media-note/media-note.component';
import { QuickActionsComponent } from '../widgets/quick-actions/quick-actions.component';
import { SliderStepperComponent } from '../widgets/slider-stepper/slider-stepper.component';
import { DateTimePickerComponent } from '../widgets/date-time-picker/date-time-picker.component';
import {
  PlaceholderReason,
  WidgetPlaceholderComponent,
} from '../widgets/widget-placeholder/widget-placeholder.component';

/** How to mount one widget type. */
export interface WidgetEntry {
  component: Type<unknown>;
  /**
   * Inputs for the dynamic mount. Omitted ⇒ no inputs (self-sourcing widget).
   * Only REQUIRED inputs are supplied here (so the mount can't throw NG0952);
   * every extra key MUST correspond to a real component input or `setInput`
   * throws NG0303 — so optional props are threaded in a follow-up, not guessed.
   */
  inputs?: (panel: ArrangedPanel) => Record<string, unknown>;
  /**
   * True when this widget accepts the read-only-aware `bound` input (the §5
   * bound-state runtime, P1-06.1). The host attaches a live {@link BoundState}
   * to a bound panel ONLY for widgets flagged here — passing `bound` to a widget
   * that does not declare that input would throw NG0303.
   */
  acceptsBoundState?: boolean;
}

/** widgetType → renderer. `slider`/`stepper` alias the single slider_stepper component. */
const REGISTRY = new Map<string, WidgetEntry>([
  // --- P0 self-sourcing widgets (no inputs) ---
  ['chat', { component: ChatComponent }],
  ['timer_stack', { component: TimerStackComponent }],
  // editable_list is bound-state-aware (P1-06.1): when the host feeds a `bound`
  // slot it renders the live list read-only-aware; absent, it self-sources.
  ['editable_list', { component: EditableListComponent, acceptsBoundState: true }],
  ['segmented_toggle', { component: SegmentedToggleComponent }],

  // --- P1 library widgets. Only their REQUIRED inputs are seeded (defaults) so
  //     a manifest that declares them renders instead of throwing; optional
  //     props/state binding is a follow-up. ---
  ['table', { component: TableComponent, acceptsBoundState: true }],
  ['tabs', { component: TabsComponent }],
  ['progress', { component: ProgressComponent }],
  ['key_value_panel', { component: KeyValuePanelComponent }],
  ['media_note', { component: MediaNoteComponent }],
  ['quick_actions', { component: QuickActionsComponent, inputs: () => ({ actions: [] }) }],
  ['slider_stepper', { component: SliderStepperComponent, inputs: () => ({ min: 0, max: 100 }) }],
  ['slider', { component: SliderStepperComponent, inputs: () => ({ min: 0, max: 100 }) }],
  ['stepper', { component: SliderStepperComponent, inputs: () => ({ min: 0, max: 100 }) }],
  ['date_time_picker', { component: DateTimePickerComponent }],
]);

/** The renderer for a widget type, or `undefined` when none is registered. */
export function widgetComponentFor(widgetType: string): Type<unknown> | null {
  return REGISTRY.get(widgetType)?.component ?? null;
}

/** The dynamic-mount inputs for a panel (empty object when the widget self-sources). */
export function widgetInputsFor(panel: ArrangedPanel): Record<string, unknown> {
  const entry = REGISTRY.get(panel.descriptor.widgetType);
  return entry?.inputs ? entry.inputs(panel) : {};
}

/** True when a widget type has a registered renderer. */
export function hasRenderer(widgetType: string): boolean {
  return REGISTRY.has(widgetType);
}

/**
 * True when a widget type accepts the read-only-aware `bound` input (P1-06.1).
 * The host only attaches a live bound state to widgets flagged here, so it never
 * pushes a `bound` input at a widget that does not declare it (NG0303).
 */
export function acceptsBoundState(widgetType: string): boolean {
  return REGISTRY.get(widgetType)?.acceptsBoundState === true;
}

/* =============================================================================
   WIDGET-LIBRARY VERSIONING + GRACEFUL PLACEHOLDER  (P1-03.7 · SPEC §9.8 · contract §11)
   -----------------------------------------------------------------------------
   The widget library is versioned and ships WITH the app. Each composed panel may
   declare a `min_widget_version`; a panel that either (a) names a widget type this
   build has never heard of, or (b) needs a library newer than what's installed,
   MUST degrade to a first-party PLACEHOLDER — never a crash, never a blank panel
   (which is exactly why `type` is a shape-checked string and not a closed enum).
   Resolving through {@link resolveWidget} means the rest of the composed agent
   keeps rendering around the one panel that can't be drawn.
   ============================================================================= */

/**
 * The installed widget-library version (`MAJOR.MINOR[.PATCH]`). Bump the MINOR
 * when a new widget type or a backward-compatible widget capability ships; a
 * panel whose `min_widget_version` exceeds this value renders the placeholder.
 */
export const WIDGET_LIBRARY_VERSION = '1.0';

/** The outcome of resolving a panel: the concrete widget, or the placeholder. */
export interface ResolvedWidget {
  component: Type<unknown>;
  inputs: Record<string, unknown>;
}

interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

/** Parse `MAJOR.MINOR[.PATCH]`; `null` when the string is absent/malformed. */
function parseVersion(v: string | null | undefined): SemVer | null {
  if (!v) return null;
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(v.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: m[3] ? Number(m[3]) : 0 };
}

/** Total order on versions: MAJOR, then MINOR, then PATCH. */
function compareVersions(a: SemVer, b: SemVer): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** The installed library version, parsed once (the constant is always well-formed). */
const INSTALLED = parseVersion(WIDGET_LIBRARY_VERSION) ?? { major: 0, minor: 0, patch: 0 };

/**
 * True when a panel's declared `min_widget_version` is STRICTLY newer than the
 * installed library. Absent/malformed versions are treated as compatible (the
 * Rust core schema-validates the field upstream, so this only needs to be
 * defensive, not a second validator) — the goal is "never wrongly hide a widget
 * we can in fact render".
 */
function isTooNew(minWidgetVersion: string | undefined): boolean {
  const req = parseVersion(minWidgetVersion);
  return req !== null && compareVersions(req, INSTALLED) > 0;
}

function toPlaceholder(
  reason: PlaceholderReason,
  widgetType: string,
  requiredVersion: string | null
): ResolvedWidget {
  return {
    component: WidgetPlaceholderComponent,
    inputs: {
      reason,
      widgetType,
      requiredVersion,
      libraryVersion: WIDGET_LIBRARY_VERSION,
    },
  };
}

/**
 * Resolve a panel to the component the host should mount, applying the §11 gate:
 *
 *   1. widget type not in the registry     → PLACEHOLDER (`unknown`)
 *   2. min_widget_version > installed lib   → PLACEHOLDER (`too_new`)
 *   3. otherwise                            → the registered widget + its inputs
 *
 * The unknown check runs FIRST (mirrors the contract pseudocode), so a panel that
 * is both unknown AND too-new reports as `unknown`. This ALWAYS returns a
 * component — the host never has to handle a `null`, so a composed agent can
 * never blank out on a single unrenderable panel.
 */
export function resolveWidget(panel: ArrangedPanel): ResolvedWidget {
  const widgetType = panel.descriptor.widgetType;
  const minVersion = panel.descriptor.minWidgetVersion;
  const entry = REGISTRY.get(widgetType);

  if (!entry) {
    return toPlaceholder('unknown', widgetType, minVersion ?? null);
  }
  if (isTooNew(minVersion)) {
    return toPlaceholder('too_new', widgetType, minVersion ?? null);
  }
  return { component: entry.component, inputs: entry.inputs ? entry.inputs(panel) : {} };
}

/**
 * True when a resolved widget is the graceful PLACEHOLDER (unknown / too-new)
 * rather than a real registered widget. The host checks this before attaching a
 * `bound` input — the placeholder has no such input, so a bound-but-too-new panel
 * must never receive one (NG0303).
 */
export function isPlaceholder(resolved: ResolvedWidget): boolean {
  return resolved.component === WidgetPlaceholderComponent;
}
