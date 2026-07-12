import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/* =============================================================================
   widget_placeholder (P1-03.7 · SPEC §9.8 / widget-contract §6 "placeholder" · §11)
   -----------------------------------------------------------------------------
   The GRACEFUL fallback the widget registry resolves to when a composed panel
   cannot be rendered by the installed widget library — either its `type` is
   UNKNOWN to this build, or its declared `min_widget_version` is NEWER than the
   installed `WIDGET_LIBRARY_VERSION`. It is itself a first-party widget: it
   NEVER crashes and NEVER renders blank (contract §11), so the rest of the
   composed agent keeps rendering around it.

   It is a terminal, data-less state (contract §6 lifecycle): a calm, accessible
   card that NAMES the situation and the widget type/version. Meaning is carried
   by ICON + TEXT, never colour alone (WCAG 1.4.1); styling is token-only
   (contract §7). Signals + OnPush; the registry sets its inputs via
   NgComponentOutlet, so every input has a benign default (no NG0952).
   ============================================================================= */

/** Why a panel degraded to the placeholder. */
export type PlaceholderReason = 'unknown' | 'too_new';

/** Module-scoped counter → per-instance DOM id prefix (labelledby/describedby uniqueness). */
let placeholderSeq = 0;

@Component({
  selector: 'app-widget-placeholder',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './widget-placeholder.component.html',
  styleUrl: './widget-placeholder.component.css',
})
export class WidgetPlaceholderComponent {
  /** Unique per-instance id prefix so many placeholders on one page keep valid ARIA wiring. */
  readonly uid = `wp-${++placeholderSeq}`;

  /** `too_new` (library too old for the panel) or `unknown` (type not in this library). */
  readonly reason = input<PlaceholderReason>('unknown');
  /** The unresolved widget-type name (e.g. `chart`), shown to the user for context. */
  readonly widgetType = input<string>('');
  /** The panel's declared `min_widget_version` (only meaningful for `too_new`). */
  readonly requiredVersion = input<string | null>(null);
  /** The installed `WIDGET_LIBRARY_VERSION`, for the "you have …" comparison. */
  readonly libraryVersion = input<string>('');

  /** The card's primary line — the exact task copy for each case. */
  readonly headline = computed<string>(() =>
    this.reason() === 'too_new'
      ? 'This skill needs a newer version of Hydropark'
      : 'Unknown panel type'
  );

  /** The explanatory line, naming the widget type and (for too-new) the versions. */
  readonly detail = computed<string>(() => {
    const type = this.widgetType() || 'This panel';
    const quoted = this.widgetType() ? `The "${type}" panel` : type;
    if (this.reason() === 'too_new') {
      const need = this.requiredVersion();
      const have = this.libraryVersion();
      const needPart = need
        ? ` needs widget library ${need} or newer`
        : ' needs a newer widget library';
      const havePart = have ? `; this app has ${have}` : '';
      return `${quoted}${needPart}${havePart}.`;
    }
    return `${quoted} isn't part of this version's widget library — it may have been added in a newer release of Hydropark.`;
  });
}
