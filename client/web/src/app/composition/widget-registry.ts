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
}

/** widgetType → renderer. `slider`/`stepper` alias the single slider_stepper component. */
const REGISTRY = new Map<string, WidgetEntry>([
  // --- P0 self-sourcing widgets (no inputs) ---
  ['chat', { component: ChatComponent }],
  ['timer_stack', { component: TimerStackComponent }],
  ['editable_list', { component: EditableListComponent }],
  ['segmented_toggle', { component: SegmentedToggleComponent }],

  // --- P1 library widgets. Only their REQUIRED inputs are seeded (defaults) so
  //     a manifest that declares them renders instead of throwing; optional
  //     props/state binding is a follow-up. ---
  ['table', { component: TableComponent }],
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
