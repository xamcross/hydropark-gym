# Hydropark contracts — Skill Manifest (P1-03.1a)

Production JSON Schema and reference manifests for a Hydropark **skill** — the
signed, declarative `prompt + tools + UI pack` that specializes the base agent
(SPECIFICATION.md §8). This directory promotes the *illustrative* manifest in
SPEC §8.2 into a **validated contract** that two consumers enforce:

- the **desktop client** at install/load (`P1-03.1` schema + normalizer,
  `P1-03.5` install lifecycle), and
- the **certification pipeline** at marketplace admission (`P1-20`).

## Files

| File | What it is |
|---|---|
| `skill-manifest.schema.json` | JSON Schema (draft 2020-12) for a skill manifest. `$id: https://schemas.hydropark.app/skill-manifest.schema.json`. Strict (`additionalProperties`/`unevaluatedProperties: false`), per-field `description`s. |
| `examples/kitchen-timer.manifest.json` | A **free** skill ("Kitchen Timer & Units", the onboarding free SKU — §26.4), written in **shorthand**. |
| `examples/cooking-assistant.manifest.json` | A **paid** skill ("Cooking Assistant", the $5 flagship — §17), written in **canonical** form, grounded in the Phase-0 persona. |

Both examples validate against the schema; see **Validating** below.

## What the manifest is (and the IP-protection rule)

**The manifest is the authoring artifact.** It carries the skill's *full*
`persona.system_prompt` — the paid intellectual property — because that prompt is
packaged verbatim into the signed `.hpskill` archive (§8.8) and used as the lead
voice when the skill is primary (§8.3.1).

That full prompt is **never served before purchase.** The split is enforced
server-side (BACKEND-DESIGN §3.2 / §4.2):

- `skills.compressed_prompt` is the **only** persona text the Catalog API returns
  to unentitled clients (`GET /catalog`, `GET /catalog/skills/{id}`). It is also
  the exact text every *secondary* skill contributes to a composed agent (§8.3.2).
- The full `system_prompt` lives **only inside the signed package**, never in a
  catalog row and never served to unentitled clients (fix **SF8**). Even
  try-before-buy previews never run it against client-supplied input, so a 3B
  model can't be coaxed into reciting the paid prompt (BACKEND-DESIGN §4.2 N1).

So: author the full prompt here; the pipeline derives the catalog's
`compressed_prompt` from this manifest and keeps the full prompt sealed in the
package.

## Shorthand → canonical normalization

A manifest may be written in **shorthand**; the client **normalizes** it to the
**canonical** contract at load (§8.2 / §9.2). Manifest and renderer thus validate
against one schema — the shorthand is a projection of the canonical form. The
schema accepts both and each shorthand field's `description` names its expansion.

| Field | Shorthand | Canonical expansion |
|---|---|---|
| `pricing` (free) | `{ "free": true }` | no price fields permitted |
| `pricing` (paid) | `{ "free": false, "price_usd": 5 }` | `{ "free": false, "price": { "amount_minor": 500, "currency": "USD" } }` (integer minor units) |
| `persona.role` | omitted | `"primary_eligible"` |
| `compatibility.combine_priority` | omitted | `50` |
| `localization.unit_system_default` | omitted | `"auto"` |
| `shared_state[].schema` | `"list<item>"` | `list<record<{ id, name, qty?, unit?, checked? }>>` with app-assigned stable `id` (§8.3.4) |
| Widget **props** | inline (`"checkable": true`, `"multi": true`, `"options": [...]`, `"default": ...`) | folded into `props: { … }` |
| Widget `region` | omitted | the widget type's default region |
| Widget `priority` | omitted | declared/inherited value |
| Widget `emits` | omitted, or a bare string `"item_checked"` | the type's default event set; string → `{ name, to_chat: <type default> }` (§9.3 #4) |
| Widget `min_widget_version` | omitted | `"1.0"` |
| `tools[]` | `{ "ref": "start_timer" }` | ref + empty config + no state routing |

`kitchen-timer.manifest.json` demonstrates the shorthand column;
`cooking-assistant.manifest.json` demonstrates the canonical column.

## Safety invariants the schema encodes

These are structural (schema-enforced), not just documented:

- **Fixed tool catalog (§8.1 / §8.5).** `tools[].ref` is a closed enum
  (`start_timer`, `convert_units`, `list_manage`, `calculate`, `date_math`). A
  skill cannot name a tool outside the audited first-party catalog; adding one is
  a reviewed, versioned catalog change (`P1-05.1`) — never shipped code.
- **No network / file / system capabilities (§8.5).** `capabilities` is a closed
  enum of tool *categories*; there is deliberately no `network`/`filesystem`/
  `system` value, so any such capability fails validation.
- **Fixed widget library (§9.1 / §9.4).** `ui.panels[].type` is a closed enum of
  the v1 widgets (`chart`/`sparkline`/`map` are Phase-2 and intentionally absent).
  `unevaluatedProperties: false` on each panel rejects both unknown keys and
  inline props that don't belong to the declared widget type.
- **Sanitized SVG only (§9.1).** `resources.assets` / `resources.icon` accept only
  package-relative `*.svg` paths; the pattern forbids remote URLs (`://`) and path
  traversal. (Content-level sanitization — strip scripts/handlers/external refs/
  inline styles — is done by `P1-03.4` / `P1-20.1`.)
- **Closed shared-state type language (§8.3.4).** `shared_state[].schema` matches
  only `scalar<…>` / `list<…>` / `record<{…}>`; arbitrary type strings are
  rejected.

## Certification-lint hooks (§8.5, P1-20)

The schema is the **structural** gate. The certification pipeline layers the
**semantic** gates on top; a skill must pass all of them to be published:

- **`P1-20.1` — automated gates:** signature + schema validation, capability/
  permission review, **budget limits**, and the **non-token-styling lint**.
  - **Budget limits (§8.5).** Per-skill hard caps on `system_prompt` tokens, tool
    count, panel count, asset size, and total package size. The schema carries
    coarse structural guards (`maxLength` on prompts, `maxItems` on
    `tools`/`ui.panels`/`shared_state`/`few_shot`/`assets`); the **token-accurate**
    limits are measured at certification because token counts are model-dependent,
    not derivable from character length.
  - **Non-token-styling lint (§9.10, house rule #5; pairs with `P1-03.8`).** Skills
    may reference only the design-token vocabulary — **no per-skill CSS, no inline
    styles, no arbitrary colors/spacing.** The schema already bars skill-supplied
    HTML/CSS/JS (only enum widget types + sanitized SVG assets); the lint rejects
    any non-token styling that slips into assets or props.
- **`P1-20.2` — behavioral eval suite** on the reference model (Qwen2.5-3B):
  representative prompts → expected tool/UI behavior. It produces the
  **certified `cost_estimate`** the capacity meter (`P1-04.7`) trusts. The
  manifest's `cost_estimate` is the author's *self-declared* input; the meter
  uses the certified figure, not the declaration alone (§8.3.5).
- **`P1-20.3` — localization completeness** for every locale in
  `resources.strings`, with graceful fallback to `localization.default_locale`
  (§8.7).
- **`P1-20.4` — safety review:** scope limits, mandatory disclaimers, and the
  deterministic (rule-based, not model-generated) allergen layer for food skills
  (§28.1).
- **`P1-20.5` — re-certification** trigger on base-model change / mid-size tier
  add (§8.6).

Cross-field rules the schema can't express (and certification enforces):
`compatibility.combine_priority` tie-breaks, `binds_state`/`binds_tool` must
reference a slot/tool the manifest declares, widget `id` uniqueness within the
agent, `capabilities` consistency with `tools`, and `localization.default_locale`
∈ `resources.strings`.

## Validating

Draft 2020-12. With Node + [ajv](https://ajv.js.org) (2020 build):

```js
import Ajv2020 from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
const ajv = new Ajv2020({ strict: true, strictRequired: false }); // required-in-if/then is idiomatic
const validate = ajv.compile(JSON.parse(readFileSync("skill-manifest.schema.json")));
const ok = validate(JSON.parse(readFileSync("examples/kitchen-timer.manifest.json")));
```

`strictRequired: false` only relaxes ajv's opinionated lint about `required`
appearing inside `if`/`then`/`not` branches (used for the `pricing` free-vs-paid
rule); it is off by default in ajv and unused by non-ajv validators, so the
schema stays portable.
