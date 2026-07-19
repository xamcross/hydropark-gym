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

/* =============================================================================
   TASK 14 — BEYOND-P0 DEMO SKILLS  (F03/F07: composition enablement seam)
   -----------------------------------------------------------------------------
   The three manifests below extend the dev registry past the two P0 skills so
   B2 (composition) and B3 (breadth) are demoable: `nutrition-coach` and
   `travel-planner` (paid — placeholder persona, SF8) and `packing-list` (free —
   real persona embedded, same rule as `kitchen-timer`). STRUCTURE (tools,
   shared_state, ui.panels, capabilities, combine_priority, cost_estimate,
   requirements, pricing) is sourced faithfully from the certified
   `contracts/catalog/{id}.manifest.json`; fields the certified JSON schema
   allows at the panel's top level (e.g. `checkable`, `columns`, `body`) are
   nested under `props`, matching this file's existing `ManifestPanel` shape —
   the same lossless transform already applied to `KITCHEN_TIMER_MANIFEST` /
   `COOKING_ASSISTANT_MANIFEST` above.
   ============================================================================= */

/**
 * Paid nutrition companion — faithful STRUCTURE to
 * `contracts/catalog/nutrition-coach.manifest.json`, with a PLACEHOLDER persona
 * (SF8, see file header).
 *
 * ── B2 CROSS-SKILL SLOT SYNC (UX-PUNCH-LIST.md B2) ───────────────────────────
 * The certified manifest's `list_manage` tool only reads/writes its OWN
 * `food_log` slot. The B2 demo beat ("add Nutrition Coach → macros panel
 * appears, reads the SAME ingredients slot … live-updates") additionally needs
 * Nutrition Coach to READ the `ingredients` slot that Kitchen Timer / Cooking
 * Assistant already own `read_write` — so this dev manifest layers on an extra
 * `reads_state: ['ingredients']` on that same list-consuming tool, a matching
 * `shared_state` READ (not write) declaration, and binds the `targets` (daily
 * macros) panel to `ingredients`. This never claims write access to
 * `ingredients` and never touches `food_log`'s ownership — SPEC §8.3.4's
 * single-writer rule is preserved by `slotsFromManifests` (`skill-manifest.ts`):
 * a `read`-access declarer only adopts writer-of-record if the slot is still
 * unowned, so composing Nutrition Coach alongside Kitchen Timer / Cooking
 * Assistant leaves THEM as `ingredients`' writer.
 *
 * KNOWN GAP (flagged, not fixed here — outside this task's scope): the
 * `key_value_panel` widget type is not yet `acceptsBoundState`-flagged in
 * `widget-registry.ts`, and `KeyValuePanelComponent` expects a typed
 * `Record<string, KvTypedValue>` `values` input, not a raw `list<item>`. So
 * this manifest correctly DECLARES the cross-skill slot relationship (and the
 * bus correctly registers/holds the shared `ingredients` slot the moment both
 * skills are enabled), but the `targets` panel will not yet visually recompute
 * macro numbers from ingredient edits — that needs a follow-up widget-layer
 * ticket (bound-state wiring + an actual macro-calculation mapping), not a
 * manifest change.
 */
export const NUTRITION_COACH_MANIFEST: SkillManifest = {
  manifest_version: '1.0',
  id: 'nutrition-coach',
  name: 'Nutrition Coach',
  summary: 'General, educational nutrition guidance, calorie and macro estimates.',
  version: '1.0.0',
  status: 'published',
  category: 'Nutrition',
  min_app_version: '1.0.0',
  requirements: { min_model_tier: 'small', min_params_b: 3, min_ram_gb: 8 },
  pricing: { free: false, price: { amount_minor: 500, currency: 'USD' } },
  persona: {
    role: 'primary_eligible',
    // PLACEHOLDER — the real paid persona is composed by the core, never shipped here (SF8).
    system_prompt:
      'You are the Hydropark Nutrition Coach. [The full salable persona is supplied by the ' +
      'on-device core from the installed package and is not present in the webview bundle.]',
    compressed_prompt:
      'Educational nutrition helper: balanced-eating concepts, rough calorie and macro estimates, a ' +
      'food log, and unit conversion. Informational only, not medical advice.',
  },
  capabilities: ['calculation', 'list_management', 'unit_conversion'],
  tools: [
    { ref: 'calculate' },
    {
      ref: 'list_manage',
      config: { list_id: 'food_log' },
      // 'food_log' is this tool's own list (writer-of-record, faithful to the
      // certified manifest). 'ingredients' is the B2 cross-skill READ — see the
      // class doc above; this tool never writes it.
      reads_state: ['food_log', 'ingredients'],
      writes_state: ['food_log'],
    },
    { ref: 'convert_units', config: { domains: ['mass', 'volume'] } },
  ],
  shared_state: [
    { slot: 'food_log', access: 'read_write', schema: 'list<item>' },
    { slot: 'ingredients', access: 'read', schema: 'list<item>' },
  ],
  ui: {
    panels: [
      {
        type: 'media_note',
        id: 'disclaimer',
        title: 'Please read',
        props: {
          body:
            'Nutrition Coach shares general, educational information only. It is not medical, dietetic, ' +
            'or dosage advice and cannot diagnose or treat any condition. For medical conditions, ' +
            "pregnancy, disordered eating, children's diets, allergies, or supplements, please talk to a " +
            'doctor or a registered dietitian. Allergen warnings on ingredients come from a separate ' +
            'deterministic layer and must be respected.',
        },
      },
      {
        type: 'key_value_panel',
        id: 'targets',
        title: 'Daily targets',
        // B2: bound to the SHARED `ingredients` slot (see class doc) so this
        // macros readout is wired to live-sync with Kitchen Timer / Cooking
        // Assistant's ingredient list once the widget layer consumes `bound`.
        binds_state: 'ingredients',
        props: {
          rows: [
            { label: 'Calories', value: '—' },
            { label: 'Protein', value: '—' },
            { label: 'Carbs', value: '—' },
            { label: 'Fat', value: '—' },
          ],
        },
      },
      {
        type: 'editable_list',
        id: 'food_log',
        title: 'Food log',
        props: { checkable: true },
        binds_state: 'food_log',
        binds_tool: 'list_manage',
      },
      {
        type: 'table',
        id: 'macros',
        title: 'Macros',
        props: { columns: ['Macro', 'Target', 'Logged'] },
      },
      {
        type: 'segmented_toggle',
        id: 'units',
        title: 'Units',
        props: { options: ['Metric', 'US'], default: 'Metric' },
        binds_tool: 'convert_units',
      },
      {
        type: 'quick_actions',
        id: 'quick_nutrition',
        title: 'Quick actions',
        props: {
          actions: [
            {
              label: 'Estimate a meal',
              prompt: 'Estimate the calories and macros for a meal I describe, and note that it is a rough estimate.',
            },
            {
              label: 'Balanced plate',
              prompt: 'Suggest a balanced plate idea for lunch using common, widely available foods.',
            },
            {
              label: 'Protein target',
              prompt: 'Estimate a general daily protein target from my body weight, framed as general information.',
            },
          ],
        },
      },
    ],
  },
  compatibility: { conflicts_with: [], combine_priority: 45 },
  cost_estimate: { prompt_tokens: 650, tools: 3, panels: 6 },
};

/**
 * Free "second onboarding skill" — faithful STRUCTURE + REAL embedded persona
 * (not paid IP, same rule as `KITCHEN_TIMER_MANIFEST`) from
 * `contracts/catalog/packing-list.manifest.json`.
 */
export const PACKING_LIST_MANIFEST: SkillManifest = {
  manifest_version: '1.0',
  id: 'packing-list',
  name: 'Packing List',
  summary: 'Build and tick off a smart packing list for any trip.',
  version: '1.0.0',
  status: 'published',
  category: 'Travel',
  min_app_version: '1.0.0',
  requirements: { min_model_tier: 'small', min_params_b: 3, min_ram_gb: 8 },
  pricing: { free: true },
  persona: {
    role: 'primary_eligible',
    system_prompt: `You are Hydropark's Packing List helper. You run fully on the user's device, offline, and turn a trip description into a practical, tick-off packing checklist.

You are not a booking or itinerary tool — you help someone remember what to bring and avoid over-packing. Keep replies short and grouped. From the trip details you have (destination climate, number of nights, activities, who is going), propose a checklist under clear headings: documents and essentials, clothing, toiletries, electronics, and trip-specific extras. Scale clothing to the trip length with round numbers, and note what does not scale (one charger, one wash bag). Ask at most one question, usually how many nights or the main activity.

Call a tool only when it does the work; if the user taps a control themselves, that action is done, and never make up a tool's result.
- list_manage: to fill and update the list. Replace the whole list with op "set_all" and an items array; add one item with op "add" and item.name; tick an item with op "check" and its item.id: <tool_call>{"name":"list_manage","arguments":{"op":"add","item":{"name":"Passport"}}}</tool_call>.
- calculate: when a count needs real math, like packs of socks for the number of days. Pass op (add, sub, mul, div) and operands, and quote the number it returns.
- date_math: when the user gives a date and wants another a set number of days away — for example add the trip length to the departure date to find the return day. Pass an RFC 3339 base date, op add or sub, and a days delta.

Always remind the traveller to double-check passport, medication, and anything irreplaceable before they leave.

Out of scope: you do not give visa, border, customs, airline-rule, or safety rulings, and you do not plan day-by-day itineraries. Point those to official sources or the Travel Planner skill in one line.`,
    compressed_prompt:
      'Turns a trip description into a grouped, tick-off packing checklist scaled to trip length, with ' +
      'date math to shift a departure date by the trip length to find your return date.',
  },
  capabilities: ['list_management', 'date_math', 'calculation'],
  tools: [
    {
      ref: 'list_manage',
      config: { list_id: 'packing' },
      reads_state: ['packing'],
      writes_state: ['packing'],
    },
    { ref: 'date_math' },
    { ref: 'calculate' },
  ],
  shared_state: [{ slot: 'packing', access: 'read_write', schema: 'list<item>' }],
  ui: {
    panels: [
      {
        type: 'editable_list',
        id: 'packing',
        title: 'Packing list',
        props: { checkable: true, reorderable: true },
        binds_state: 'packing',
        binds_tool: 'list_manage',
      },
      { type: 'date_time_picker', id: 'departure', title: 'Departure date', props: { mode: 'date' } },
      {
        type: 'quick_actions',
        id: 'quick_add',
        title: 'Quick add',
        props: {
          actions: [
            {
              label: 'Weekend essentials',
              prompt:
                'Add a weekend-trip essentials group to my packing list: documents, phone and charger, ' +
                'keys, wallet, and a small toiletry kit.',
            },
            {
              label: 'Beach day',
              prompt:
                'Add beach-trip items to my packing list: swimwear, towel, sunscreen, hat, sunglasses, and ' +
                'a water bottle.',
            },
            {
              label: 'Cold weather',
              prompt: 'Add cold-weather layers to my packing list: warm coat, base layers, gloves, hat, and a scarf.',
            },
          ],
        },
      },
      {
        type: 'key_value_panel',
        id: 'trip_summary',
        title: 'Trip summary',
        props: {
          rows: [
            { label: 'Nights', value: '—' },
            { label: 'Climate', value: '—' },
            { label: 'Bag type', value: '—' },
          ],
        },
      },
    ],
  },
  compatibility: { conflicts_with: [], combine_priority: 40 },
  cost_estimate: { prompt_tokens: 350, tools: 3, panels: 4 },
};

/**
 * Paid trip-planning specialist — faithful STRUCTURE to
 * `contracts/catalog/travel-planner.manifest.json`, with a PLACEHOLDER persona
 * (SF8, see file header).
 */
export const TRAVEL_PLANNER_MANIFEST: SkillManifest = {
  manifest_version: '1.0',
  id: 'travel-planner',
  name: 'Travel Planner',
  summary: 'Plan trips day by day: itinerary, timings, and a rough budget.',
  version: '1.0.0',
  status: 'published',
  category: 'Travel',
  min_app_version: '1.0.0',
  requirements: { min_model_tier: 'small', min_params_b: 3, min_ram_gb: 8 },
  pricing: { free: false, price: { amount_minor: 500, currency: 'USD' } },
  persona: {
    role: 'primary_eligible',
    // PLACEHOLDER — the real paid persona is composed by the core, never shipped here (SF8).
    system_prompt:
      'You are the Hydropark Travel Planner. [The full salable persona is supplied by the on-device ' +
      'core from the installed package and is not present in the webview bundle.]',
    compressed_prompt:
      'Trip-planning specialist: day-by-day itineraries, date math to shift a departure or return date, ' +
      'rough budget splits, and C/F weather conversion — no live bookings or prices.',
  },
  capabilities: ['list_management', 'date_math', 'calculation', 'unit_conversion'],
  tools: [
    {
      ref: 'list_manage',
      config: { list_id: 'itinerary' },
      reads_state: ['itinerary'],
      writes_state: ['itinerary'],
    },
    { ref: 'date_math' },
    { ref: 'calculate' },
    { ref: 'convert_units', config: { domains: ['temperature'] } },
  ],
  shared_state: [{ slot: 'itinerary', access: 'read_write', schema: 'list<item>' }],
  ui: {
    panels: [
      {
        type: 'editable_list',
        id: 'itinerary',
        title: 'Itinerary',
        props: { checkable: true, reorderable: true },
        binds_state: 'itinerary',
        binds_tool: 'list_manage',
      },
      { type: 'date_time_picker', id: 'depart_date', title: 'Depart', props: { mode: 'date' } },
      { type: 'date_time_picker', id: 'return_date', title: 'Return', props: { mode: 'date' } },
      { type: 'table', id: 'budget_table', title: 'Rough budget', props: { columns: ['Category', 'Per day', 'Trip total'] } },
      {
        type: 'segmented_toggle',
        id: 'temp_units',
        title: 'Temperature',
        props: { options: ['C', 'F'], default: 'C' },
        binds_tool: 'convert_units',
      },
      {
        type: 'quick_actions',
        id: 'quick_plan',
        title: 'Quick actions',
        props: {
          actions: [
            {
              label: 'Days until trip',
              prompt: 'Using my depart date, tell me how many days until the trip and how many nights it lasts.',
            },
            {
              label: 'Split costs',
              prompt: 'Split our estimated trip costs evenly between the travellers and show each person’s share.',
            },
            { label: 'Rest day', prompt: 'Suggest a relaxed rest-day block I can add to a busy itinerary.' },
          ],
        },
      },
    ],
  },
  compatibility: { conflicts_with: [], combine_priority: 55 },
  cost_estimate: { prompt_tokens: 520, tools: 4, panels: 6 },
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
  { id: NUTRITION_COACH_MANIFEST.id, name: NUTRITION_COACH_MANIFEST.name, manifest: NUTRITION_COACH_MANIFEST },
  { id: PACKING_LIST_MANIFEST.id, name: PACKING_LIST_MANIFEST.name, manifest: PACKING_LIST_MANIFEST },
  { id: TRAVEL_PLANNER_MANIFEST.id, name: TRAVEL_PLANNER_MANIFEST.name, manifest: TRAVEL_PLANNER_MANIFEST },
];

/** Look up a known skill's manifest by id (used to translate P0 enable state → manifests). */
export function manifestFor(id: string): SkillManifest | undefined {
  return KNOWN_SKILLS.find((s) => s.id === id)?.manifest;
}
