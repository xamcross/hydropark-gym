# Hydropark — "the agent gym" landing page

An alternative positioning to `../landing/`. Where that page sells one $5 SKU to
cold traffic, this one sells **the composition system**: a free local agent you
equip with skills, mix, and save as reusable loadouts.

Three static files, no build step, no dependencies.

```
index.html    markup, copy, and the skill catalogue (as data attributes)
styles.css    the design system
app.js        the loadout planner + funnel events
```

## The one honest constraint

SPEC §2.2 lists **"training/fine-tuning models by end users"** as an explicit
non-goal. A page called "the agent gym" is one careless sentence away from
promising exactly that. So section `00` says it outright — *you are not training
a model, the weights never change, you are loading the bar* — and the first FAQ
repeats it. Do not soften this. It is the difference between a metaphor and a lie,
and it is cheaper to say here than in a refund email.

## The planner is real

The centre of the page is not a diagram. It runs the app's own two models over the
catalogue encoded in the plate buttons' `data-*` attributes — kept deliberately
separate, exactly as the app keeps them.

**Prompt assembly (SPEC §8.3.1, the illustration).** Drives the bar and the
"system prompt this builds" panel.

- **One skill leads.** The lead spends its full `system_prompt` plus few-shot
  examples; every other skill contributes only its one-line `compressed_prompt`,
  its tools, and its panels. That is why the bar draws the lead as the big plate and
  a secondary as a sliver.
- **Tools and panels are unioned and deduplicated** by `type#id` (§8.3.3). Load the
  three "Saturday Jobs" skills and the planner reports duplicates merged — they all
  declare `media_note#safety_note` and two share `timer_stack#timers`; the app draws
  one of each.
- **Shared-state slots** light up when a writer and a reader are both loaded (§8.3.4).

**Capacity meter (SPEC §8.3.5, mirrors `client/src-tauri/src/capacity.rs`).** Drives
the gauge and the verdict.

- **Every enabled skill is charged in full**: its certified
  `cost_estimate.prompt_tokens` plus `tools × 8 + panels × 16`, summed with **no lead
  discount and no tool-union discount**, against a **fixed 4096-token window** with a
  **1024-token working reserve** (so skills may fill 3072). The block fires when the
  total exceeds the window, *before* the skill is enabled, and names one to drop.
- **The meter blocks; speed only warns; it never shrugs.** A context overflow refuses
  the plate. A throughput below ~8 tok/s, or a window ≥ 85 % full, warns amber and
  still allows. Nothing you already loaded is ever silently disabled.
- **Capacity does not change with the bench.** Hardware changes *speed*, not *what
  fits* (§8.3.5): the bench selector moves the tok/s readout and the speed warning
  only. Toggle it and the speed moves while the capacity verdict stays put.
- **Conflicts are refused**: the page declares `Kitchen Timer & Units` and
  `Cooking Assistant` in each other's `conflicts_with` (see the divergence note below).

The arithmetic is what argues, not the copy: `Saturday Jobs` (Home & DIY + Car Care +
Garden, 2436 of 3072 skill-tokens) is Ready with room for none of the other heavy
skills — a fourth overflows by 134 tokens on **every** bench. Set the bench to **8 GB,
no graphics card** and nothing about *what fits* changes; what changes is the speed
verdict, which warns because that tier runs below the ~8 tok/s floor. Do not tune this
to flatter the product.

### Tuning the numbers

The **capacity-meter** constants at the top of `app.js` are copied verbatim from
`capacity.rs`: `N_CTX` (4096), `RESERVE` (1024), `SKILL_BUDGET` (3072), `PER_TOOL`
(8), `PER_PANEL` (16), `SPEED_FLOOR` (8 tok/s), `FILL_WARN` (0.85). Do **not** tune
these to flatter the product — if they ever disagree with `capacity.rs`, the page is
wrong, so change the page. The `TIERS` table now carries **speed only** (`tokps`,
`label`); there is no per-bench budget.

Per-skill numbers live on the plate buttons in `index.html`. The certified capacity
figure is `data-cost-estimate` (= the manifest's `cost_estimate.prompt_tokens`), and
the visible `<n> tok / <n> tools / <n> panels` is the manifest's
`cost_estimate.{prompt_tokens, tools, panels}`. The lead-heavy `data-prompt` /
`data-fewshot` / `data-compressed` numbers exist **only** to drive the §8.3.1 assembly
illustration; `data-tools` / `data-panels` (real `ref` / `type#id` lists),
`data-priority`, `data-role`, `data-conflicts`, `data-writes`, `data-reads` drive lead
choice, the tool/panel union, conflicts, and the shared-state wires.

**Cost provenance (P1-24.3).** All ten launch skills are certified under
`contracts/catalog/`, so every plate carries `data-certified="true"`,
`data-cost-estimate` = its manifest's `cost_estimate.prompt_tokens` (mirrored in
`data-prompt`, with `data-fewshot=0` since the manifest bundles few-shot into
`prompt_tokens`), and a `data-cost-source` pointing at
`contracts/catalog/<id>.manifest.json#/cost_estimate`. `app.js` asserts the trace at
load and logs any drift, so a catalogue edit that forgets a plate is caught in the
console rather than shipping a page that lies about the meter.

## Shareable loadouts

`?load=cooking-assistant,nutrition-coach&tier=minimum&lead=travel-planner`
restores a rack. The **Copy this loadout** button writes that URL to the clipboard.
Invalid, conflicting, or over-budget ids in the URL are skipped rather than
throwing. This doubles as the way to screenshot a given state.

## Before it goes live

Three files still carry clearly-marked `REPLACE_ME`/PLACEHOLDER launch gates — by
design, so a half-configured deploy fails loud, not silent:

1. **`CHECKOUT_URL`** (top of `app.js`) — the payment-provider seam (P1-24.1). It is
   the Merchant-of-Record hosted-checkout base URL; the provider is the seller of
   record and derives the taxed price from `(skills, region)` server-side. While it
   says `REPLACE_ME` the buy button fires `checkout_click`, logs a console warning,
   and **does not navigate**. Swapping providers is a one-line change here. The live
   MoR merchant account is a launch gate — do **not** point it at a test link.
   **`DOWNLOAD_URL`** behaves the same for the download buttons.
2. **Analytics** (`index.html` `<head>`, P1-24.2) — the cookieless Plausible/dataLayer
   snippet is wired: the stub captures every funnel event `track()` already emits, on
   all three pages. To go live, set `data-domain` (`REPLACE_ME_DOMAIN`) and un-comment
   the one loader line. Until then events only queue — nothing leaves the device.
3. **`/privacy` + `/terms`** are now real pages (`privacy.html`, `terms.html`) and the
   footer points at them. The Terms carry the business-continuity commitment
   (SPEC §28.2) verbatim-faithful, plus the AI-advice disclaimers (§28.1). The
   seller-of-record / liability sections are marked PLACEHOLDER pending X-LEGAL.3.
4. The support address is set to `hello@hydropark.app` (placeholder inbox).

### P1-24.3 — done

The plate set now equals the ten certified launch skills authored under
`contracts/catalog/` (`kitchen-timer`, `packing-list`, `cooking-assistant`,
`travel-planner`, `nutrition-coach`, `home-diy`, `garden-plants`, `car-care`,
`budget-bills`, `study-flashcards`), every plate's `data-cost-estimate` and visible
`tok / tools / panels` copied from its manifest's `cost_estimate`, and the capacity
**meter** rewritten to mirror `capacity.rs` exactly (full per-skill charge, fixed
4096-token window, 1024-token reserve, `tools × 8 + panels × 16`, block-on-overflow,
speed-only warnings, no per-bench budget). The §8.3.1 prompt-**assembly** illustration
(the bar and the "system prompt this builds" panel) is kept as a separate, lead-heavy
view and is *not* the meter.

**Where the illustration still diverges from the certified manifests** — deliberately
outside P1-24.3's cost/capacity scope, a follow-up copy/assembly pass rather than a bug:

- **Shared-state wiring.** The `data-writes` / `data-reads` slots and the routines /
  "shared state" narrative (`ingredients`, `packing_list`, `shopping_list`,
  `trip_dates`) are illustrative. In the real catalog each skill only touches its
  **own** slot (`packing`, `materials`, `itinerary`, `food_log`, `cards`, …); no two
  *different* skills are wired together (the only shared slot, `ingredients`, is between
  Kitchen Timer and Cooking Assistant, which conflict).
- **Conflicts.** The page declares `kitchen-timer` ↔ `cooking-assistant` in
  `conflicts_with`; both manifests declare `conflicts_with: []`.
- **Lead eligibility.** `nutrition-coach` is shown `secondary_only` ("Never leads");
  its manifest is `primary_eligible`. The page's `data-priority` values are the
  illustration's lead-pick order, not the manifests' `combine_priority`.

These drive the assembly / lead / wires illustration, not the capacity meter, and are
flagged rather than rewritten in this ticket.

## Measuring

`track()` pushes to `window.dataLayer` and forwards to `window.plausible` when
present. Events: `lp_view`, `plate_added`, `plate_removed`, `plate_refused`
(`{reason: conflict|capacity}`), `lead_changed`, `bench_changed`,
`preset_loaded`, `loadout_copied`, `download_click`, `checkout_click`
(`{skills, count, price}`).

`plate_refused` with `reason: capacity` is worth watching. If a large share of
visitors hit the wall on the default bench, either the tier defaults are wrong or
the catalogue is too heavy — both are product findings, not copy problems.

## Design notes

An equipment room: cold graphite, chalk, one sulphur yellow, a fine knurl texture,
stencil numerals, tape labels. Archivo (expanded, heavy) for display, Chivo for
body, Martian Mono for readouts — deliberately nothing shared with the paper-and-
letterpress `../landing/`.

Colour is restrained so it can carry meaning: **chalk means fine, sulphur means
careful, rust means no.** The bar, the gauge, and the verdict all move together.
Bright sulphur fails contrast on the light pricing slab, so text there uses
`--sulphur-ink`.

### Accessibility

Plates are `aria-pressed` toggle buttons; the bench is a real radiogroup with arrow
keys; the barbell is `aria-hidden` and everything it shows is also in the text
readout, which is `aria-live="polite"`. Refusals go to an `aria-live="assertive"`
alert, and on narrow screens the page scrolls that alert into view — otherwise a
refused tap reads as a dead button. `prefers-reduced-motion` disables the shake and
the reveals. Without JavaScript the catalogue still renders as a plain list.

Grids that use the 1px-gap-over-background trick (`.hero__stats`, `.readout`,
`.tiers`, `.rules__list`) declare **explicit column counts at every breakpoint**.
An `auto-fit` track that leaves an empty cell exposes the grid's own background as
a pale block. If you add a card, fix the column maths.
