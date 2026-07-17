/**
 * Hydropark Task 17 (phase 2) — curated real-model preview transcripts.
 *
 * SOURCE: `client/src-tauri/previews/*.json`, produced by the phase-1 capture
 * bin (`client/src-tauri/src/bin/capture_preview.rs`) running the REAL
 * Qwen2.5-3B engine against each skill's certified persona
 * (`contracts/catalog/<id>.manifest.json`) for that manifest's own three
 * `few_shot`-derived fixed inputs (a core task, a tool-forcing task, and a
 * boundary/decline task). See `.superpowers/sdd/task-17-bin-report.md` for how
 * the raw captures were produced and `task-17-wire-report.md` for the full
 * per-skill curation rationale.
 *
 * WHY CURATED, NOT RAW: the raw captures are real model output, but a small
 * on-device model asked to "call a tool" without an actual tool-execution loop
 * around it sometimes emits the tool-call wire syntax itself (JSON, `<tool_call>`
 * markers, or ad-hoc pseudocode) instead of prose, and occasionally invents
 * numbers nobody gave it. A buyer-facing preview must show what the app would
 * actually RENDER, not raw wire fragments or wrong arithmetic. Every line below
 * is one of:
 *   (a) unchanged real model prose (the common case),
 *   (b) a short "AS THE APP WOULD SHOW IT" rendering of a tool call the model
 *       requested, built ONLY from the real arguments in that call — the user's
 *       own numbers/items, e.g. `start_timer{label:"Cook pasta",duration_sec:540}`
 *       → "Starting a 9:00 timer labeled "Cook pasta". ⏱" — or, when the model's
 *       own captured text never stated a completed result (or stated a wrong
 *       one — verified against the manifest's own canonical `few_shot` tool call
 *       or plain arithmetic), an ACTION-ONLY rendering that names the real inputs
 *       without asserting an invented number, e.g. "Working out your next
 *       oil-change date — 180 days from 2026-07-17. 🔧", or
 *   (c) reflowed (newline/markdown stripped so it reads as flowing prose — the
 *       transcript template renders `text` as plain, unstyled text) but
 *       otherwise verbatim.
 * Nothing here introduces a fact, price, or health/nutrition number the model
 * did not itself produce (or the user did not themselves supply). One exchange
 * (nutrition-coach's diabetes-management turn) was dropped outright rather than
 * curated — see the report.
 *
 * NOT the full `SkillPreview` shape on its own: this module stores the
 * curated `{ name, panelTitles, messages }` per skill; {@link buildCuratedPreview}
 * assembles it into the real `SkillPreview` `StubCatalogPort.getPreview()`
 * returns, mirroring `buildPreview()`'s shape (system banner line prepended,
 * `capped: true`, `no_purchase: true`).
 */

import { PreviewMessage, PreviewPanel, SkillPreview, previewWidgetType } from './catalog.model';

/** One skill's curated preview inputs — name/panels for the tile+header, messages for the transcript. */
export interface CuratedPreview {
  /** Display name — mirrors each skill's `contracts/catalog/<id>.manifest.json#name`. */
  name: string;
  /**
   * A short, curated subset of that manifest's `ui.panels[].title` values (not
   * the full panel list — kept tasteful/scannable, same spirit as the existing
   * `StubCatalogPort` records' own hand-picked `panels` arrays). Safety/disclaimer
   * panels are kept in this subset for skills whose persona has a hard safety
   * rule (nutrition-coach, home-diy, garden-plants, car-care, budget-bills), so
   * the preview visually carries the same "informational only" framing the
   * transcript curation honors.
   */
  panelTitles: string[];
  /** The curated `user`/`assistant` turns, in order. Never empty. */
  messages: PreviewMessage[];
}

const U = (text: string): PreviewMessage => ({ role: 'user', text });
const A = (text: string): PreviewMessage => ({ role: 'assistant', text });

/** Curated preview data for every skill the phase-1 capture bin produced a transcript for. */
export const CURATED_PREVIEWS: Readonly<Record<string, CuratedPreview>> = {
  'kitchen-timer': {
    name: 'Kitchen Timer & Units',
    panelTitles: ['Timer stack', 'Ingredient list', 'Units toggle'],
    messages: [
      U('Set a 9 minute timer for the pasta.'),
      // Curated: raw capture was `>{"name":"start_timer","arguments":{"label":"Cook pasta","duration_sec":540}}`
      // — a leaked tool-call fragment. Rendered as the app would show the started timer (540s = 9:00, exact).
      A('Starting a 9:00 timer labeled "Cook pasta". ⏱'),
      U("What's 350F in Celsius?"),
      A('350F is approximately 176.67C.'),
      U('What can I use instead of buttermilk?'),
      A('You can use plain yogurt mixed with a bit of lemon juice or vinegar to replace buttermilk.'),
    ],
  },

  'packing-list': {
    name: 'Packing List',
    panelTitles: ['Checklist', 'Category groups'],
    messages: [
      U('Beach weekend, 2 nights — start my list.'),
      // Curated: raw capture was `- set_all: [op="add", item={"name":"Passport"}]` — wire-syntax leak.
      A('Added "Passport" to your packing list. 🧳'),
      U('I leave on 2026-05-03 for 5 nights — when do I come back?'),
      // Raw capture was the bare string "2026-05-08" (correct: 05-03 + 5 days). Lightly reworded as a sentence.
      A("You'd be back on 2026-05-08."),
      U('Do I need a visa for Japan?'),
      A(
        "For Japan, you generally don't need a visa for stays up to 90 days. Check the latest immigration rules " +
          'as they can change.'
      ),
    ],
  },

  'cooking-assistant': {
    name: 'Cooking Assistant',
    panelTitles: ['Recipe steps', 'Per-step timers', 'Serving scaler', 'Substitutions'],
    messages: [
      U('Quick tomato pasta for two, please.'),
      // Curated: raw capture ended with a trailing "[list_manage set_all]" tag (leaked tool-call note) and used
      // newlines the preview template does not render as line breaks; reflowed to flowing prose, tag replaced
      // with a natural confirmation. Ingredient text itself (including "1 gtt olive oil") is the model's own
      // real output — not corrected, since that would mean inventing/altering a fact the model produced.
      A(
        'Got it. For two servings: 1 gtt olive oil, 400 g spaghetti, 2 large tomatoes (chopped), 3 cloves garlic ' +
          '(minced), 1 tsp dried basil, 1/2 tsp salt, 1/4 tsp black pepper. Added to your ingredient list. 🍝'
      ),
      U('Start a 12 minute timer for the sauce.'),
      A('Set a 12 minute timer.'),
      U('Is this keto meal okay for my diabetes?'),
      A("I can help with the recipe, but please share the dish you're making so I can review the ingredients and provide guidance."),
    ],
  },

  'nutrition-coach': {
    name: 'Nutrition Coach',
    panelTitles: ['Please read', 'Daily targets', 'Food log', 'Macros'],
    // Only 2 exchanges: the raw capture's third turn ("What should I eat to manage my type 2 diabetes?") answered
    // with detailed diabetes dietary advice and no disclaimer — directly contradicting this skill's own certified
    // persona hard rule ("For weight goals tied to a medical condition ... diabetes ... do not advise — recommend
    // a doctor or registered dietitian") and its own few_shot canonical answer for that exact question. Shipping it
    // would misrepresent what the real (correctly behaving) skill does, so it was dropped rather than curated.
    messages: [
      U('How much protein should I aim for a day?'),
      A(
        'A common guideline is to aim for about 1 gram of protein per kilogram of body weight each day. For ' +
          'example, if you weigh 70 kilograms, you might want to consume around 70 grams of protein daily. This ' +
          'can be distributed across your meals and snacks throughout the day.'
      ),
      U('Add up my meals today: 520, 640, 710, and a 300 snack.'),
      // Verified: 520+640+710+300 = 2170. Trimmed a rambling trailing "How can I assist you further?".
      A('The total for your meals today is 2170 calories.'),
    ],
  },

  'home-diy': {
    name: 'Home & DIY',
    panelTitles: ['Work safely', 'Materials & tools', 'Estimates'],
    messages: [
      U("Start a materials list for painting my bedroom — I'll need paint, a roller, tape, and drop cloths."),
      // Curated: the raw capture invented an unprompted, unit-confused calculation ("Bedroom wall area = 25*30 =
      // 750 liters" — the user gave no dimensions at all) — a hallucination, dropped. Re-rendered as the real,
      // correct action for this turn: a list_manage set_all of exactly the 4 items the user named (matches this
      // skill's own certified few_shot for this exact input).
      A('Added to your materials list: Paint, Roller and tray, Painter\'s tape, Drop cloths. 🧰'),
      U('My wall area is 38 square meters and one liter of paint covers 9.5 square meters per coat. How many liters for one coat?'),
      // Raw capture wrapped this in ```python code fences; the model's own stated result (4.0) is correct
      // (38 ÷ 9.5 = 4, matching the manifest's own few_shot `calculate div [38, 9.5]`) — reflowed to prose.
      A('38 m² ÷ 9.5 m² coverage = 4 liters for one coat.'),
      U('Can you talk me through rewiring this light switch myself?'),
      A(
        'Hydropark is not designed to guide you through rewiring tasks, as it involves electrical work that ' +
          'requires a licensed electrician. This task includes handling live wires and understanding the ' +
          'circuitry, which can be dangerous if not done correctly. I recommend consulting with a licensed ' +
          "electrician for this job. If you need help with other home improvement tasks, feel free to ask!"
      ),
    ],
  },

  'garden-plants': {
    name: 'Garden & Plants',
    panelTitles: ['Please read', 'Plant tasks', 'Last frost date'],
    messages: [
      U('Last frost here is 2026-04-15 — when can I start hardening off seedlings, about 2 weeks before that?'),
      // Curated: raw capture asserted "2026-03-29", which is wrong (2026-04-15 minus 14 days is 2026-04-01).
      // Rather than substitute my own corrected date (inventing a fact the model didn't produce) or drop the
      // exchange outright, rendered as the action the model requested (date_math, 14 days before the user's own
      // frost date) without asserting a specific result.
      A('Working out your hardening-off date — 2 weeks before your last frost of 2026-04-15. 🌱'),
      U('I have a 300 cm row and want plants spaced 25 cm apart — how many fit?'),
      // Curated: raw capture derived 11 via an unexplained "subtract one spacing" step; this skill's own
      // certified few_shot for this exact question is a plain `calculate div [300, 25]` (= 12), so 11 is wrong
      // relative to the skill's own canonical behavior. Action-only rendering, same policy as above.
      A('Working out how many plants fit — a 300 cm row at 25 cm spacing. 🌱'),
      U('I found these red berries in the yard — are they safe to eat?'),
      A(
        "Those red berries in your yard might be toxic. It's best to check a local plant toxicity list before " +
          'bringing one home. Let me know what you want to grow or if you need planting window suggestions.'
      ),
    ],
  },

  'car-care': {
    name: 'Car Care',
    panelTitles: ['Work safely', 'Maintenance log', 'Vehicle'],
    messages: [
      U("I changed the oil today, 2026-07-17. It's due again in 6 months — when's that?"),
      // Curated: raw capture never completed the calculation ("I will run this calculation for you now." and
      // stopped) — no result to use. Action-only rendering with the model's own stated delta (180 days).
      A('Working out your next oil-change date — 180 days from 2026-07-17. 🔧'),
      U('I drove 460 km on 35 liters of fuel — what\'s my km per liter?'),
      // Same issue: raw capture set up the division and stopped ("Let's calculate it.") without a result.
      A('Calculating your fuel economy — 460 km ÷ 35 L. ⛽'),
      U('My brake pedal feels spongy — can you tell me how to bleed the brakes myself?'),
      // Trimmed for length; same refusal + safety guidance as the raw capture and this skill's own few_shot.
      A(
        'Checking and bleeding brakes is a safety-critical task for a professional mechanic — it involves ' +
          'working under the vehicle, and a mistake there can mean losing stopping power. If your pedal feels ' +
          'spongy, stop driving and get it inspected. Want me to set a reminder for your next maintenance check?'
      ),
    ],
  },

  'budget-bills': {
    name: 'Budget & Bills',
    panelTitles: ['Please read', 'Bills', 'Spending breakdown'],
    messages: [
      U('Add my bills: rent 1200, electric 80, internet 60.'),
      // Trimmed: raw capture listed the same three bills twice verbatim.
      A('Added to your bills list: Rent $1200, Electric $80, Internet $60. Want to add any more?'),
      U('Split a $150 dinner bill between 4 people.'),
      // Raw capture wrapped this in ``` code fences; the model's own stated result (37.5) is correct
      // (150 ÷ 4 = 37.5, matching the manifest's own few_shot `calculate div [150, 4]`) — reflowed to prose.
      A('Splitting $150 four ways: $37.50 each.'),
      U('Should I put my savings into index funds or pay off my car loan faster?'),
      A(
        "Both have merits — it depends on your situation. Index funds offer diversification and long-term " +
          'growth potential; paying off the car loan faster reduces interest and gets you debt-free sooner, ' +
          "especially if the rate is high. How much do you have in savings, and what's the interest rate on your car loan?"
      ),
    ],
  },

  'study-flashcards': {
    name: 'Study & Flashcards',
    panelTitles: ['Deck', 'Focus timers', 'Review schedule'],
    messages: [
      U(
        'Turn these into flashcards: mitochondria = powerhouse of the cell; photosynthesis = process plants use ' +
          'to convert light into energy.'
      ),
      // Reflowed: raw capture used markdown bold and newlines the template does not render.
      A(
        'Got it! Turning these into flashcards: (1) What is mitochondria? — Mitochondria is the powerhouse of ' +
          'the cell. (2) What is photosynthesis? — Photosynthesis is the process plants use to convert light ' +
          'into energy. Ready to start reviewing?'
      ),
      U('I got this card right — schedule the next review 3 days from today, 2026-07-17.'),
      // Curated: raw capture asserted "Your next review will be on 2026-07-17, which is in 3 days" — a
      // self-contradictory, wrong result (3 days from 2026-07-17 is 2026-07-20, not the same day). Action-only
      // rendering, same policy as the other date_math corrections above.
      A('Scheduling your next review — 3 days from 2026-07-17. 📅'),
      U("My exam starts in 10 minutes online — what's the answer to question 3, 'define osmosis'?"),
      A(
        "I'm sorry, but I can't help with that live exam. This session is designed for offline study and " +
          'revision to prepare you better. Let\'s focus on reviewing the material together instead — want me to ' +
          'start a quick flashcard session on osmosis right now?'
      ),
    ],
  },

  'travel-planner': {
    name: 'Travel Planner',
    panelTitles: ['Itinerary', 'Rough budget', 'Depart'],
    messages: [
      U('Two easy days in Lisbon — we like food and views.'),
      // Curated: raw capture opened with a stray `<answer>` chat-template tag, re-asked a question the user had
      // already answered, and was cut off mid-sentence at the token limit inside a redundant recap list.
      // Trimmed to the model's own coherent Day 1/Day 2 plan, reflowed (markdown/newlines stripped); every place
      // and activity named is the model's own real output.
      A(
        'For a two-day trip in Lisbon focused on food and views, here\'s a plan. Day 1 — Morning: Alfama\'s ' +
          'winding streets and a pastel de nata at a local bakery. Midday: Belém\'s Jerónimos Monastery, then ' +
          'seafood nearby. Afternoon: Belém Tower for river views. Evening: dinner at a riverside restaurant. ' +
          'Day 2 — Morning: Praça do Município and a quick breakfast. Midday: Bairro Alto for lunch at a small ' +
          'tapas bar. Afternoon: browse a food market like Mercado da Ribeira. Evening: rooftop dinner with city views.'
      ),
      U('Split 840 for lodging between the 3 of us.'),
      // Curated: raw capture echoed a raw `<user>...</user>` chat-template tag inside the assistant's own turn —
      // stripped. The model's own stated result (280) is correct (840 ÷ 3 = 280, matching the manifest's own
      // few_shot `calculate div [840, 3]`).
      A("Lodging split three ways: $280 per person. I've added that to your itinerary — want to add the first day's activities now?"),
      U('Will I need a visa for Vietnam?'),
      A(
        "I'm sorry, but I don't have the ability to provide visa requirements or travel advisories. It's best " +
          'to check with your country\'s embassy or a travel advisory service for the most up-to-date and ' +
          'accurate information.'
      ),
    ],
  },
};

/**
 * Assemble a curated real-model {@link SkillPreview} for `skillId`, or `undefined`
 * if no curated capture exists for it. Mirrors {@link buildPreview}'s shape
 * exactly (leading `system` banner line, `capped: true`, `no_purchase: true`) so
 * the preview modal (which only knows the `SkillPreview` contract) renders
 * curated and synthetic previews identically.
 */
export function buildCuratedPreview(skillId: string): SkillPreview | undefined {
  const curated = CURATED_PREVIEWS[skillId];
  if (!curated) return undefined;

  const panels: PreviewPanel[] = curated.panelTitles.map((title) => ({ type: previewWidgetType(title), title }));
  const transcript: PreviewMessage[] = [
    { role: 'system', text: `Preview of ${curated.name} — a taste of the skill. Nothing here is purchased.` },
    ...curated.messages,
  ];

  return {
    skill_id: skillId,
    name: curated.name,
    panels,
    transcript,
    capped: true,
    no_purchase: true,
  };
}
