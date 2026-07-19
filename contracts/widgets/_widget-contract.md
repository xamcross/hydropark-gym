# Base Widget Contract

**Ticket:** P1-06.1 · **SPEC:** §9.2 (widget contract), §9.3 (bus & bindings), §8.3.4 (shared state / writer-of-record), §9.8 (versioning/placeholder), §9.10 / §9.1 (tokens & a11y) · **Schema:** [`_widget-base.schema.json`](./_widget-base.schema.json)

This is the contract **every** widget in the v1 library (SPEC §9.4, the ~12 types) obeys. The 12 per-widget schemas are authored against it next (P1-06.4a–.4l); each `allOf`-extends the base schema, pins `type`, tightens `props`, and reuses the shared `$defs` defined here. The renderer, the orchestrator's binding/merge layer, and the certification pipeline all validate against this one contract, so a dozen skills from different authors render as one app.

> **Canonical vs shorthand.** This document and the base schema describe the **canonical** widget object. A skill manifest (§8.2) may author the **shorthand** projection — type-specific props inline, and `region`/`priority`/`emits`/`min_widget_version` omitted. At load the app **normalizes** shorthand → canonical (inline props fold into `props`; omitted fields take the widget-type's defaults) and then validates. There is exactly one schema; the manifest is a projection of it (SPEC §9.2).

---

## 1. The envelope

Canonical form (see the [manifest example](../../SPECIFICATION.md), §9.2). Every field below is defined in the schema; this table is the human contract.

| Field | Req | Type | Meaning |
|---|:--:|---|---|
| `type` | ✔ | widget-type name | Which library widget renders this panel. **Not a closed enum** — an unknown/too-new type degrades to a placeholder (§10), never a validation failure. |
| `id` | ✔ | snake_case id | Unique **within the agent**. Cross-widget uniqueness is a merge-time check, not a schema one. Routing target for `updates_widget` and dedup key (with `type`+binding). |
| `title` | | localizable string | Panel heading; default accessible name. |
| `region` | | `side`\|`bottom`\|`inline` | Dock region (§9.5). Omitted → the widget-type's default region. |
| `priority` | | int 0–1000 (def 50) | Placement order within a region (higher first). |
| `min_widget_version` | | `MAJOR.MINOR[.PATCH]` (def `1.0`) | Minimum widget-**library** version needed (§10). |
| `props` | | object (per-type) | Typed configuration. Base leaves open; each per-widget schema closes it. |
| `binds_state` | | slot name | Two-way slot binding (§4, §5). Effective read/write mode is **resolved** at merge, not authored. |
| `reads_state` | | slot name[] | Extra slots observed **read-only** for display (§4). |
| `binds_tool` | | tool ref | User actions invoke this tool via the UI-first path (§4, dir 2). |
| `emits` | | event decl[] | Events posted to the bus (§3). Omitted → the type's default event set. |
| `states` | | object | Copy overrides for loading/empty/error (§6). Cannot disable a state. |
| `a11y` | | object | Accessible-name/description overrides (§8). Mechanical a11y is not the skill's to author. |
| `style` | | object | Closed set of semantic **style variants** (§7). The entire skill-facing styling surface. |

**Widget = declaration only.** A widget never ships HTML/JS/CSS; it declares a type + bindings + props + variant selections, and the first-party renderer draws it (SPEC §9.1). The model can change a widget **only** by calling a tool or writing a slot — it never emits UI code or directives (§9.3 "Model ↔ UI bridge").

---

## 2. Typed props + typed state

Every widget type defines two typed shapes:

- **Props** — authored, immutable-per-instance configuration (`checkable`, `options`, `max_items`, …). Declared in the per-widget schema under `props` with `additionalProperties:false`. The base leaves `props` open so each type can close it independently.
- **Runtime state** — the widget's live data, owned by the **core** (Rust) when it must survive the webview not looking (timers, the ingredient list, the unit system); the webview renders a projection (see `IPC-CONTRACT.md`, responsibility split). Runtime state is **session-scoped by default**; a skill may opt into per-agent/template persistence (§9.9, P1-06.8). Runtime state is **not** authored in the manifest — it is produced by tools, slots, and user input.

Every widget's runtime state passes through the **lifecycle state machine** in §6.

---

## 3. The event contract & the four binding directions

Each active agent has **one** event + state **bus** that mediates all UI dynamism. Bindings flow in exactly four directions (SPEC §9.3):

| # | Direction | Mechanism | Contract |
|---|---|---|---|
| 1 | **widget ↔ slot** (two-way) | `binds_state` | Editing the widget writes the slot **iff** the owning skill is the slot's writer-of-record; anything writing the slot re-renders the widget. Non-writers bind **read-only** (§5). |
| 2 | **widget → tool** (action) | `binds_tool` | A user action invokes the tool **deterministically** — the UI-first path, no model round-trip (§8.4 point 1). This is the reliability backstop for a 3B model. |
| 3 | **tool/model → widget** (update) | tool `writes_state` / `updates_widget` | A tool result writes a slot (→ every widget with `binds_state`/`reads_state` on that slot re-renders) or targets a named widget id; the model's only levers are calling tools and writing slots. |
| 4 | **widget event → conversation** | `emits[].to_chat` | An emitted event with `to_chat:true` posts a **system line** into the transcript ("⏱ Pasta timer finished"). |

### `emits`

Each entry is either a bare **event name** (uses the widget-type's default `to_chat`) or `{ "name", "to_chat" }` overriding it. Certification rejects duplicate event names within one widget.

**Posting an event does NOT auto-run inference.** It appends a line to the transcript and, if the event is time-critical, fires the OS notification (§9.7). The model responds only when the **user** sends the next turn. This keeps behavior predictable and avoids background-inference drain — a timer finishing on a backgrounded app must **not** wake the model (SPEC §9.3 point 4).

---

## 4. Binding hooks

A widget declares its bindings explicitly; routing is **keyed on slot name**, never guessed from field names, so it stays unambiguous when a tool is shared or namespaced across skills (§8.3.3) or when several widgets bind one slot (SPEC §9.3 "Tool ↔ slot ↔ widget routing").

- **`binds_state`** — the primary slot this widget renders and (when writer-of-record) edits.
- **`reads_state[]`** — additional slots observed **read-only** for display (e.g. a `key_value_panel` showing macros for the `ingredients` slot it does not own). An update to any observed slot re-renders the widget.
- **`binds_tool`** — the tool a user action invokes (direction 2).

**Tool-side routing (the counterpart, authored on the tool ref in the manifest, not on the widget — P1-03.1 / P1-05.3).** A tool ref declares `writes_state` / `reads_state` naming the slots it touches. Result routing:

1. Tool declares `writes_state` → the named slot(s) update → **every** widget bound to those slots re-renders (direction 3).
2. Tool declares no `writes_state` but a named **`updates_widget`** → the result routes to that widget id.
3. Otherwise → the result routes to **chat** by default.

Any widget is a valid `updates_widget` target simply by having an `id`; no opt-in flag is required.

---

## 5. Read-only bound state (writer-of-record)

A slot has exactly **one writer-of-record**: the highest-priority `read_write` declarer (merge order = primary → `combine_priority` desc → `id` asc, §8.3.2). A widget's `binds_state` is **two-way only if its owning skill is that writer**. Otherwise it binds **read-only**, and the widget **MUST**:

1. **Render live** — reflect every update to the slot in real time (it is a first-class view, not a stale copy);
2. **Disable all edit affordances** — inputs, add/remove/reorder/check controls, toggles, steppers are non-interactive (visually and via `aria-disabled` / `disabled`); and
3. **Name the owner** — expose a tooltip / accessible description of the form *"Managed by {writer-of-record skill name}"* so the user knows where edits go.

User edits are therefore always routed through the writer-of-record, which removes the apparent conflict between "two-way binding" (§9.3 #1) and "one writer-of-record" (SPEC §8.3.4). Non-writers may still contribute through **tools**: for `list`/`record` slots a non-writer's tool may **append/patch** (adds and field-updates that don't delete others' entries, commutative by entry `id`); for `scalar` slots only the writer-of-record may **set** the value.

> The read-only decision is **resolved at merge time** and delivered to the widget as runtime state (`{ readonly: true, writer: <skillId/name> }`). It is never authored in the manifest — a skill cannot grant itself write access to a slot it does not own.

---

## 6. Mandatory loading / empty / error states

**Every** widget implements the visual states below so skills never have to (SPEC §9.2). They are part of the widget-library implementation and verified by the X-A11Y + certification gates; a skill may override **copy** (via `states`) but can never suppress a state.

| State | When | Requirement |
|---|---|---|
| **loading** | data/tool in flight | Determinate or indeterminate progress affordance; never a blank panel. |
| **empty** | bound successfully, no data | Plain, non-alarming line ("No ingredients yet."). Distinct from error. |
| **error** | tool/execution failure | Human message + recovery affordance ("Couldn't convert — check the value."). Structured tool-execution errors are surfaced, never silently swallowed (§8.4 point 4). |
| **read-only** | bound to a slot this skill doesn't own (§5) | Renders live; edit affordances disabled; owner named. |
| **placeholder** | unknown / too-new widget type (§10) | "This panel needs a newer version of the app" + update prompt. Terminal; no data render. |

Full runtime state machine (per widget instance):

```
                       ┌─────────── error (retry/dismiss) ───────────┐
                       ▼                                              │
 mount ──▶ loading ──▶ ready ──▶ { empty | populated } ──user/tool──▶ (re)loading
             │           │
             │           └──▶ read-only (if not writer-of-record) ── renders live, no edits
             └──▶ placeholder  (type unknown / min_widget_version too high — terminal)
```

Copy for `loading`/`empty`/`error` comes from the widget-type default; the `states` field overrides only the strings (localizable), never the behavior.

---

## 7. Design-token styling rule (house rule)

**Skills ship no CSS, no raw tokens, no inline styles** (SPEC §9.1: "No code, no remote content, no inline styles"; §9.10: "Skills pick from token-defined variants only — no per-skill CSS"). The **entire** skill-facing styling surface is the closed `style` vocabulary of **semantic variants**:

| Variant | Values |
|---|---|
| `tone` | `default` · `neutral` · `accent` · `positive` · `caution` · `danger` |
| `emphasis` | `subtle` · `normal` · `strong` |
| `density` | `comfortable` · `compact` |
| `align` | `start` · `center` · `end` |

Each variant maps **first-party** to design tokens (color / spacing / type / radius, per-theme, AA-safe). This is the "skill-facing design-token API" (P1-03.8). The manifest schema's `additionalProperties:false` on `style` means any attempt to author a raw token (`"--color-primary": "#fff"`) or arbitrary value is rejected at validation.

**The non-token-styling lint (P1-03.8 / P1-20.1).** Beneath the variant API, the widget-library **implementation** may reference **only** the constrained token vocabulary — every color/spacing/type/radius/motion value in widget CSS must be a `var(--token)` drawn from the design-token namespaces (`--color-*`, `--space-*`, `--radius-*`, `--font-*`/`--text-*`, `--transition-*`/`--motion-*`, …; see `$defs/designTokenNamespace`). Literal hex/px/rem or ad-hoc keyword styling **fails certification**. One definition of the vocabulary is shared by the token system (P1-01.3) and the lint, so twelve widgets from different authors stay one coherent app.

---

## 8. Accessibility contract (hard requirement, both themes)

Every widget must meet **all** of the following, in **both** light and dark themes, on **every** state in §6 — this is a per-widget acceptance bar enforced by the X-A11Y automated gate (axe + keyboard-nav + screen-reader-label audit, X-A11Y.1), not an aspiration:

1. **WCAG-AA contrast** for all text and meaningful non-text, verified **per theme** (a token that passes on dark may fail on light and vice-versa — cf. the `--sulphur-ink` precedent, P1-01.4).
2. **No hue-only meaning (WCAG 1.4.1).** Any status/verdict/tone conveyed by color is **always** paired with text and/or an icon. `style.tone` is never the sole signal (e.g., a `danger` row also carries a label/icon).
3. **Full keyboard operability** — every affordance reachable and operable by keyboard, with a sensible focus order and visible focus.
4. **Screen-reader labels/roles (ARIA)** — correct roles, names, and `aria-live` for out-of-band updates (a finished timer must announce). The skill may override the accessible name/description via `a11y`; the mechanical roles/focus/live-regions are supplied by the widget-library implementation and are **not** waivable by a skill.
5. **Scalable text / zoom** (§18, X-A11Y.3) — layouts remain usable when text is scaled up.
6. **Reduce-motion aware** — enable/disable transitions (§9.6) collapse under the OS "reduce motion" setting (already wired globally via the motion tokens).

---

## 9. Shared-state closed type language

Slot schemas (declared in a manifest's `shared_state`, consumed by widgets via `binds_state`) use a **small closed set** of types (SPEC §8.3.4). Authored as a **string DSL**; normalized to the object form in `$defs/slotType`.

| Kind | DSL example | Normalized (`slotType`) |
|---|---|---|
| scalar | `scalar<string>` · `scalar<number>` · `scalar<bool>` · `scalar<enum(US\|Metric)>` | `{ kind:"scalar", scalar:"enum", values:["US","Metric"] }` |
| list | `list<item>` · `list<scalar<string>>` | `{ kind:"list", of:"item" }` |
| record | `record<{kcal:number, protein_g:number}>` | `{ kind:"record", fields:{…}, required_fields:[…] }` |

**`item`** is the app-defined record `{ id, name, qty?, unit?, checked? }` (`$defs/itemRecord`). Its `id` is a **stable, app-assigned entry id** set on insert — **never** chosen by a caller on `add` — which is what makes cross-skill append/patch merges commutative and deterministic. Only `id` and `name` are required; the rest are optional, so two skills' `list<item>` slots stay compatible.

**Widget ↔ slot-kind fit.** Each widget type accepts a particular slot kind for its `binds_state` (e.g. `editable_list` → `list<item>`; `segmented_toggle`/`switch` → `scalar<enum(...)>`/`scalar<bool>`; `key_value_panel` → `record<...>`; `table` → `list<record<...>>`). Per-widget schemas document this via `$defs/acceptsSlotKind`; because the concrete slot's kind lives in `shared_state`, the fit is a **cross-artifact certification check** (P1-04.5), not an in-envelope constraint.

---

## 10. Slot schema compatibility (structural equality after optional-field widening)

Two skills declaring the **same slot name** are **compatible** iff their normalized `slotType`s are **structurally equal after optional-field widening** (SPEC §8.3.4 / §8.3.5):

- **same base `kind`**;
- **scalar** → same `scalar` primitive (and, for `enum`, the same required member set);
- **list** → compatible `of` (recursively);
- **record** → the **same set of REQUIRED fields**; extra **optional** fields on either side are allowed.

Incompatible schemas **block** the combination with a message **naming the differing fields** ("Nutrition Coach needs `ingredients` to include a required `grams` field that Cooking Assistant does not provide."). JSON Schema cannot compare two instances, so this rule is implemented by the orchestrator (P1-04.5); it is recorded as prose + `$defs/slotCompatibilityRule` so there is a single source of truth.

---

## 11. Widget-library versioning & graceful placeholder

The widget library is **versioned and ships with the app** (SPEC §9.8). Each widget instance declares `min_widget_version`. At load, the renderer resolves:

```
render(widget):
  if widget.type ∉ installed_library.types      -> PLACEHOLDER  (unknown type)
  if widget.min_widget_version > installed_library.version -> PLACEHOLDER  (too new)
  else                                          -> render the typed widget
```

The **placeholder** is itself a first-party widget: it shows *"This panel needs a newer version of the app"* plus an update prompt, and **never crashes or renders blank**. This lets skills adopt new widgets without breaking older installs (forward compatibility). It is exactly why `type` is a shape-checked string, **not** a closed enum, in the base schema — a manifest referencing a future widget must validate and then placeholder, not fail to load.

`min_widget_version` composes with `min_app_version` (inherited from the skill, §8.6) and `requirements.min_model_tier`; all three gate install/enable/render independently.

---

## 12. Conformance checklist (what each per-widget schema + component must satisfy)

Every P1-06.4x widget (schema + Angular component) is accepted only if it:

1. `allOf`-extends `_widget-base.schema.json`, pins `type` to its `knownWidgetTypeV1` const, and closes `props` with `additionalProperties:false`.
2. Declares its accepted **slot kind** for `binds_state` (§9) and its default **region**, **priority**, and **event set** (with per-event `to_chat` defaults, §3).
3. Implements **loading / empty / error** states, plus **read-only** (§5) and **placeholder** (§11) where applicable, with type-default copy overridable via `states` (§6).
4. Reads all bindings via **slot name** (§4); the model never touches it except through tools/slots.
5. Uses **only** the design-token vocabulary — zero literal styling — and exposes styling solely through the `style` variant set (§7); passes the non-token-styling lint (P1-20.1).
6. Passes the **X-A11Y** gate in **both** themes on every state: per-theme AA, no hue-only meaning (WCAG 1.4.1), full keyboard, ARIA labels/roles/live-regions, scalable text, reduce-motion (§8).

---

## 13. Worked examples

**Two-way, writer-of-record (Cooking Assistant owns `ingredients`):**

```json
{
  "type": "editable_list", "id": "ingredients", "title": "Ingredients",
  "region": "side", "priority": 60,
  "props": { "checkable": true, "reorderable": true, "max_items": 100 },
  "binds_state": "ingredients", "binds_tool": "list_manage",
  "emits": ["item_checked"], "min_widget_version": "1.0"
}
```

**Read-only observer (Nutrition Coach reads the same slot it does not own — §5):**

```json
{
  "type": "key_value_panel", "id": "macros", "title": "Nutrition",
  "region": "side", "priority": 40,
  "reads_state": ["ingredients"],
  "style": { "tone": "accent", "density": "compact" },
  "min_widget_version": "1.0"
}
```

Here `macros` renders live macros for the exact `ingredients` list, shows edit-disabled with a *"Managed by Cooking Assistant"* tooltip on any inline affordance, and re-renders whenever `list_manage` updates the slot — no copying, no model round-trip. That is the "combination feels magical" payoff of §8.3.4, delivered entirely through this contract.
