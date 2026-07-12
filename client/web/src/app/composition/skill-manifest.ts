/* =============================================================================
   HYDROPARK — CLIENT MANIFEST VIEW + DERIVATIONS  (P1 live-flow wiring)
   -----------------------------------------------------------------------------
   The subset of a signed `.hpskill` manifest the WEBVIEW reads to drive the
   composed-agent UI: the panel/widget declarations (→ layout-dock descriptors),
   the shared-state slot table (→ bus registration), and the per-tool routing
   fallback. The authoritative manifest schema lives in `contracts/` and the
   full validation/merge/capacity/routing pipeline runs in Rust
   (`client/src-tauri/src/composition.rs`); this file only projects the fields
   the Angular side needs and NEVER re-implements validation.

   Nothing here imports Angular except the layout/bus contract types it maps
   into, so the projections stay pure and unit-testable.
   ============================================================================= */

import { PanelDescriptor, PanelRegion } from '../shared/layout/layout.model';
import { SlotDescriptor, SlotKind, ToolRoutingDecl } from '../shared/bus';
import { ComposedAgentView } from '../ipc/contract';

// ---------------------------------------------------------------------------
// The manifest fields the webview consumes (a strict subset of the schema).
// ---------------------------------------------------------------------------

export interface ManifestPersona {
  role?: string;
  system_prompt?: string;
  compressed_prompt?: string;
}

export interface ManifestToolDecl {
  ref: string;
  config?: Record<string, unknown>;
  reads_state?: string[];
  writes_state?: string[];
  /** Explicit single-widget target when the tool neither writes state nor posts to chat. */
  updates_widget?: string | null;
}

export interface ManifestSharedState {
  slot: string;
  access: 'read' | 'read_write';
  /** Schema hint, e.g. `list<item>` / `record` / `scalar<string>`; drives the slot kind. */
  schema?: string;
}

/** A `ui.panels[]` entry — the widget-contract §1 declaration. */
export interface ManifestPanel {
  type: string;
  id: string;
  title?: string;
  region?: PanelRegion;
  priority?: number;
  props?: Record<string, unknown>;
  binds_state?: string;
  binds_tool?: string;
  collapsible?: boolean;
  pinnable?: boolean;
  resizable?: boolean;
}

export interface ManifestCompatibility {
  conflicts_with?: string[];
  combine_priority?: number;
}

/** The client-facing manifest projection. Assignable to `unknown[]` for `compose_agent`. */
export interface SkillManifest {
  id: string;
  name: string;
  summary?: string;
  category?: string;
  version?: string;
  status?: string;
  persona?: ManifestPersona;
  tools?: ManifestToolDecl[];
  shared_state?: ManifestSharedState[];
  ui?: { panels?: ManifestPanel[] };
  compatibility?: ManifestCompatibility;
  cost_estimate?: { prompt_tokens?: number; [extra: string]: unknown };
  /** Keep the raw object open — a manifest carries more than the webview reads. */
  [extra: string]: unknown;
}

// ---------------------------------------------------------------------------
// Widget-type defaults (the merge layer resolves these when a panel omits them).
// ---------------------------------------------------------------------------

const DEFAULT_REGION: Record<string, PanelRegion> = {
  timer_stack: 'side',
  editable_list: 'side',
  table: 'side',
  tabs: 'side',
  key_value_panel: 'side',
  media_note: 'inline',
  segmented_toggle: 'bottom',
  progress: 'bottom',
  quick_actions: 'bottom',
  slider_stepper: 'bottom',
  slider: 'bottom',
  stepper: 'bottom',
  date_time_picker: 'bottom',
};

const DEFAULT_PRIORITY = 50;

export function defaultRegionFor(widgetType: string): PanelRegion {
  return DEFAULT_REGION[widgetType] ?? 'side';
}

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------

export function manifestId(m: SkillManifest): string {
  return m.id;
}

/**
 * Project a manifest's `ui.panels[]` into layout-engine {@link PanelDescriptor}s,
 * resolving each widget-type's default region/priority when the panel omits them
 * (mirrors the merge layer's normalisation). Ordering / dedupe / folding are the
 * dock's job — this only maps shapes.
 */
export function panelsFromManifest(m: SkillManifest): PanelDescriptor[] {
  const panels = m.ui?.panels ?? [];
  return panels.map((p) => ({
    widgetType: p.type,
    id: p.id,
    binding: p.binds_state,
    region: p.region ?? defaultRegionFor(p.type),
    priority: p.priority ?? DEFAULT_PRIORITY,
    title: p.title,
    collapsible: p.collapsible,
    pinnable: p.pinnable,
    resizable: p.resizable,
  }));
}

/** All panel descriptors across an enabled set (the dock dedupes by type+id+binding). */
export function panelsFromManifests(manifests: readonly SkillManifest[]): PanelDescriptor[] {
  return manifests.flatMap(panelsFromManifest);
}

function slotKindFromSchema(schema: string | undefined): SlotKind {
  if (!schema) return 'scalar';
  if (schema.startsWith('list')) return 'list';
  if (schema.startsWith('record')) return 'record';
  return 'scalar';
}

/**
 * Build the bus's {@link SlotDescriptor} table from every skill's `shared_state`.
 * A slot's writer-of-record is the FIRST enabled skill (merge order) that
 * declares it `read_write` — matching SPEC §8.3.4's single-writer rule; later
 * skills that also bind it become read-only observers. Duplicate slot names
 * merge (first read_write writer wins).
 */
export function slotsFromManifests(manifests: readonly SkillManifest[]): SlotDescriptor[] {
  const out = new Map<string, SlotDescriptor>();
  for (const m of manifests) {
    for (const s of m.shared_state ?? []) {
      const existing = out.get(s.slot);
      if (!existing) {
        out.set(s.slot, {
          slot: s.slot,
          kind: slotKindFromSchema(s.schema),
          access: s.access,
          // A read_write declarer owns it; a read-only declarer leaves it
          // unowned until some skill claims write access.
          writerOfRecord: s.access === 'read_write' ? m.id : ' ',
        });
      } else if (existing.writerOfRecord === ' ' && s.access === 'read_write') {
        out.set(s.slot, { ...existing, access: 'read_write', writerOfRecord: m.id });
      }
    }
  }
  return [...out.values()];
}

/**
 * The per-tool routing declarations the bus applies to a tool result. Prefers
 * the AUTHORITATIVE routing from the composed view (Rust `RouteView`) when
 * present; otherwise falls back to reading each manifest's `tools[]` decls
 * directly (used before/without a successful `compose_agent`).
 */
export function routingDeclsFrom(
  composed: ComposedAgentView | null,
  manifests: readonly SkillManifest[]
): Map<string, ToolRoutingDecl> {
  const map = new Map<string, ToolRoutingDecl>();

  if (composed) {
    for (const r of composed.routing) {
      const prev = map.get(r.tool_ref);
      const widget = r.target.startsWith('widget:') ? r.target.slice('widget:'.length) : null;
      map.set(r.tool_ref, {
        reads_state: mergeUnique(prev?.reads_state, r.reads),
        writes_state: mergeUnique(prev?.writes_state, r.writes),
        updates_widget: widget ?? prev?.updates_widget ?? null,
      });
    }
    return map;
  }

  // Fallback: manifest-declared routing (one decl per tool ref; a bound panel is
  // the implicit widget target when the tool neither writes state nor chats).
  for (const m of manifests) {
    const boundWidgetByTool = new Map<string, string>();
    for (const p of m.ui?.panels ?? []) {
      if (p.binds_tool) boundWidgetByTool.set(p.binds_tool, p.id);
    }
    for (const t of m.tools ?? []) {
      const prev = map.get(t.ref);
      map.set(t.ref, {
        reads_state: mergeUnique(prev?.reads_state, t.reads_state),
        writes_state: mergeUnique(prev?.writes_state, t.writes_state),
        updates_widget: t.updates_widget ?? prev?.updates_widget ?? boundWidgetByTool.get(t.ref) ?? null,
      });
    }
  }
  return map;
}

function mergeUnique(a: readonly string[] | undefined, b: readonly string[] | undefined): string[] {
  return [...new Set([...(a ?? []), ...(b ?? [])])];
}
