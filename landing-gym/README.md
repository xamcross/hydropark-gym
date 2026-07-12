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

The centre of the page is not a diagram. It runs the app's own merge algorithm
(SPEC §8.3) over the catalogue encoded in the plate buttons' `data-*` attributes:

- **One skill leads.** The lead spends its full `system_prompt` plus few-shot
  examples; every other skill contributes only its one-line `compressed_prompt`,
  its tools, and its panels (§8.3.1). That is why the first plate is heavy and the
  fifth is nearly free — and why the bar draws the lead as the big plate.
- **Tools and panels are unioned and deduplicated** by `type#id` (§8.3.3). Load all
  seven and the planner reports "3 duplicates merged" — four skills want a date picker;
  the app draws one.
- **Shared-state slots** light up when a writer and a reader are both loaded (§8.3.4):
  Cooking writes `ingredients`, Nutrition reads it.
- **The capacity meter blocks or warns; it never shrugs** (§8.3.5). Context overflow
  refuses the plate *before* it is enabled and names one to drop. A speed shortfall
  only warns. Changing the bench never silently disables anything you already loaded.
- **Conflicts are refused**: `Kitchen Timer & Units` and `Cooking Assistant` declare
  each other in `conflicts_with`.

Set the bench to **8 GB, no graphics card** and the page argues against itself:
two skills ready, a third amber, the fourth refused. That is the spec's own
"2–4 skills on minimum hardware" guidance, arrived at by arithmetic rather than
asserted. This is the most persuasive thing on the page — do not tune it to
flatter the product.

### Tuning the numbers

All accounting lives at the top of `app.js`: `PREAMBLE`, `BASE_PERSONA`,
`TOOL_COST`, `SLUGGISH`, and the `TIERS` table. Per-skill costs live on the plate
buttons in `index.html` (`data-prompt`, `data-fewshot`, `data-compressed`,
`data-tools`, `data-panels`, `data-priority`, `data-role`, `data-conflicts`,
`data-writes`, `data-reads`).

These are the app's **estimates**, and the footer says so. If the real capacity
meter ever disagrees with this page, this page is wrong — change it.

**Cost provenance (P1-24.3).** Each plate now declares `data-certified` and
`data-cost-source`. A `certified="true"` plate's lead figure
(`data-prompt` + `data-fewshot`) equals its manifest's `cost_estimate.prompt_tokens`,
mirrored in `data-cost-estimate`; `app.js` asserts this at load and logs any drift, so
a catalogue edit that forgets to re-sync a plate is caught in the console. A
`certified="false"` plate is a design estimate whose skill is not yet authored under
`contracts/catalog/` — shown, but never presented as a real certified cost.

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

### ⚠ Two things P1-24.3 could not finish (blocked, not skipped)

- **The certified launch catalog does not exist yet.** P1-24.3 wants the plate set to
  equal the 8–10-paid certified catalog authored under `contracts/catalog/` (P1-22),
  with costs from each manifest's `cost_estimate`. Only **two** manifests exist today
  (`kitchen-timer`, `cooking-assistant`, in `contracts/examples/`). Those two plates
  now carry `data-certified="true"` and trace their token figure to the manifest's
  `cost_estimate.prompt_tokens` (190 and 380). The other six plates are
  `data-certified="false"` design estimates — kept so the planner still demonstrates,
  flagged so the page never *claims* a certification that has not happened. Skills #7–#8
  are still "owner picks" (P1-22.9/.10). Finish P1-22 → author each `contracts/catalog/`
  manifest → the plate `data-cost-estimate` copies straight from `cost_estimate`.
- **The page's capacity math diverges from the shipped meter** (`client/src-tauri/src/
  capacity.rs`). The real gate charges *every* enabled skill its full
  `cost_estimate.prompt_tokens + tools*8 + panels*16` against a fixed model context
  window with a working reserve — no lead discount, no tool-union costing, and the
  budget does **not** change with the bench (hardware changes *speed*, not *what fits*).
  This page still uses the older lead-heavy / secondary-light / tool-union / per-bench-
  budget model. That is fine for the §8.3.1 prompt-**assembly** illustration (the bar,
  the "system prompt this builds" panel), but the capacity **meter's arithmetic** must be
  reconciled to `capacity.rs` to fully honour the "if they disagree, the page is wrong"
  invariant. It needs the full certified catalog to land first, so it is left as tracked
  follow-up rather than rewritten blind.

## Measuring

`track()` pushes to `window.dataLayer` and forwards to `window.plausible` when
present. Events: `lp_view`, `plate_added`, `plate_removed`, `plate_refused`
(`{reason: conflict|capacity}`), `lead_changed`, `lead_refused`, `bench_changed`,
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
