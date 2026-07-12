/* =============================================================================
   HYDROPARK — KNOWN-SKILL MANIFEST REGISTRY  (P1 live-flow wiring, DEV/DEMO)
   -----------------------------------------------------------------------------
   The client-side manifests the composed-agent flow feeds to `compose_agent`.

   ── SOURCE OF TRUTH ──────────────────────────────────────────────────────────
   The authoritative, signed manifests live in `contracts/examples/*.manifest.json`
   and, in a real build, are supplied by the Rust core from the INSTALLED
   `.hpskill` packages — they are NOT meant to ship in the webview bundle. This
   registry is the dev/offline stand-in (the composition analogue of
   `StubCatalogPort`) so the compose experience runs under `ng serve`/`ng build`
   with no core. When the core exposes an "installed manifests" seam, this file
   is replaced by that fetch — nothing downstream changes.

   ── IP PROTECTION (SF8) ──────────────────────────────────────────────────────
   The PAID skill's real `system_prompt` (its salable persona) is deliberately
   NOT embedded here — the webview never holds it. `cooking-assistant` below
   carries a short non-paid placeholder `system_prompt` plus its public
   `compressed_prompt`; in production the core composes the real persona
   in-process from the installed package. The free onboarding skill's prompt is
   not paid IP, so it is embedded verbatim.
   ============================================================================= */

import { SkillManifest } from './skill-manifest';

/** Free onboarding skill — the P0 kitchen demo, faithful to the contract example. */
export const KITCHEN_TIMER_MANIFEST: SkillManifest = {
  manifest_version: '1.0',
  id: 'kitchen-timer',
  name: 'Kitchen Timer & Units',
  summary: 'Named cooking timers and instant US/metric conversion.',
  version: '1.0.0',
  status: 'published',
  category: 'Cooking',
  min_app_version: '1.0.0',
  requirements: { min_model_tier: 'small', min_params_b: 3, min_ram_gb: 8 },
  pricing: { free: true },
  persona: {
    role: 'primary_eligible',
    system_prompt:
      'You are the Hydropark Kitchen Timer & Units helper — a small, dependable kitchen sidekick that ' +
      'runs fully on-device. Keep the cook on time and get quantities right: offer named countdown ' +
      'timers for time-bound steps, convert US/metric on request (the app does the exact arithmetic), ' +
      'and maintain a tick-off ingredient checklist. Only start_timer, convert_units, and list_manage ' +
      'exist — never invent others. Be brief and practical.',
    compressed_prompt:
      'Kitchen timers plus exact US/metric unit conversion and a tick-off ingredient checklist.',
  },
  capabilities: ['timers', 'unit_conversion', 'list_management'],
  tools: [
    { ref: 'start_timer' },
    { ref: 'convert_units', config: { domains: ['mass', 'volume', 'temperature'] } },
    { ref: 'list_manage', config: { list_id: 'ingredients' }, writes_state: ['ingredients'] },
  ],
  shared_state: [{ slot: 'ingredients', access: 'read_write', schema: 'list<item>' }],
  ui: {
    panels: [
      { type: 'timer_stack', id: 'timers', title: 'Timers', binds_tool: 'start_timer' },
      {
        type: 'editable_list',
        id: 'ingredients',
        title: 'Ingredients',
        binds_state: 'ingredients',
        binds_tool: 'list_manage',
      },
      { type: 'segmented_toggle', id: 'unit_system', title: 'Units', binds_tool: 'convert_units' },
    ],
  },
  compatibility: { conflicts_with: [], combine_priority: 40 },
  cost_estimate: { prompt_tokens: 190, tools: 3, panels: 3 },
};

/**
 * Paid cooking companion — faithful STRUCTURE (tools / shared_state / panels /
 * combine_priority), but with a PLACEHOLDER persona: the salable prompt is never
 * bundled in the webview (SF8). See the file header.
 */
export const COOKING_ASSISTANT_MANIFEST: SkillManifest = {
  manifest_version: '1.0',
  id: 'cooking-assistant',
  name: 'Cooking Assistant',
  summary: 'A hands-on offline cook: recipes, substitutions, scaling, and timers.',
  version: '1.2.0',
  status: 'published',
  category: 'Cooking',
  min_app_version: '1.0.0',
  requirements: { min_model_tier: 'small', min_params_b: 3, min_ram_gb: 8 },
  pricing: { free: false, price: { amount_minor: 500, currency: 'USD' } },
  persona: {
    role: 'primary_eligible',
    // PLACEHOLDER — the real paid persona is composed by the core, never shipped here (SF8).
    system_prompt:
      'You are the Hydropark Cooking Assistant. [The full salable persona is supplied by the ' +
      'on-device core from the installed package and is not present in the webview bundle.]',
    compressed_prompt:
      'Cooking specialist: recipes, ingredient substitutions with ratios, serving-scaling, and step ' +
      'timers, with deterministic allergen warnings.',
  },
  capabilities: ['timers', 'unit_conversion', 'list_management'],
  tools: [
    { ref: 'start_timer' },
    { ref: 'convert_units', config: { domains: ['mass', 'volume', 'temperature'] } },
    {
      ref: 'list_manage',
      config: { list_id: 'ingredients' },
      reads_state: ['ingredients'],
      writes_state: ['ingredients'],
    },
  ],
  shared_state: [{ slot: 'ingredients', access: 'read_write', schema: 'list<item>' }],
  ui: {
    panels: [
      {
        type: 'timer_stack',
        id: 'timers',
        title: 'Timers',
        region: 'side',
        priority: 70,
        props: { multi: true },
        binds_tool: 'start_timer',
      },
      {
        type: 'editable_list',
        id: 'ingredients',
        title: 'Ingredients',
        region: 'side',
        priority: 60,
        props: { checkable: true, reorderable: true, max_items: 100 },
        binds_state: 'ingredients',
        binds_tool: 'list_manage',
      },
      {
        type: 'segmented_toggle',
        id: 'unit_system',
        title: 'Units',
        region: 'bottom',
        priority: 50,
        props: { options: ['US', 'Metric'], default: 'US' },
        binds_tool: 'convert_units',
      },
    ],
  },
  compatibility: { conflicts_with: [], combine_priority: 60 },
  cost_estimate: { prompt_tokens: 380, tools: 3, panels: 3 },
};

/** A composable, installable skill known to the client (dev registry). */
export interface KnownSkill {
  id: string;
  name: string;
  manifest: SkillManifest;
}

/** The registry the compose experience offers. Keyed by manifest id. */
export const KNOWN_SKILLS: readonly KnownSkill[] = [
  { id: KITCHEN_TIMER_MANIFEST.id, name: KITCHEN_TIMER_MANIFEST.name, manifest: KITCHEN_TIMER_MANIFEST },
  { id: COOKING_ASSISTANT_MANIFEST.id, name: COOKING_ASSISTANT_MANIFEST.name, manifest: COOKING_ASSISTANT_MANIFEST },
];

/** Look up a known skill's manifest by id (used to translate P0 enable state → manifests). */
export function manifestFor(id: string): SkillManifest | undefined {
  return KNOWN_SKILLS.find((s) => s.id === id)?.manifest;
}
