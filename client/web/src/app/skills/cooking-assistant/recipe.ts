/**
 * Recipe model for the paid Cooking Assistant skill (P0-05.3). Mirrors the
 * Rust `Recipe`/`RecipeStep` shapes in
 * `client/src-tauri/src/skills/cooking_assistant/mod.rs` so the two sides agree
 * on the recipe-steps affordance.
 *
 * IMPORTANT — allergens: the `allergens` field here is AUTHORED sample
 * metadata, derived from (and documented against) the canonical deterministic
 * layer at `client/src-tauri/src/skills/allergen/allergens.json`. The TS side
 * deliberately does NOT re-implement the allergen map — that would duplicate the
 * single source of truth. In the real app the panel gets these from an IPC
 * `allergen_scan` call into the Rust layer (see the wiring note in the task
 * report); in the mock/dev build the sample recipe carries them so the safety
 * affordance is still visible. The model is NEVER the source of these.
 */
import { UnitId } from '../../ipc/contract';

export interface RecipeIngredient {
  name: string;
  qty?: number;
  unit?: UnitId;
  /** false => does NOT scale linearly with servings (salt, leavening, eggs-as-binder judgement). */
  scalesLinearly: boolean;
}

export interface StepTimer {
  label: string;
  durationSec: number;
}

export interface RecipeStep {
  number: number;
  text: string;
  /** Present when the step is time-bound and should offer a `start_timer`. */
  timer?: StepTimer;
}

export interface Substitution {
  ingredient: string;
  swap: string;
  /** The ratio/technique note — the load-bearing part of a substitution. */
  ratio: string;
}

export interface Recipe {
  title: string;
  /** Servings the base `ingredients` quantities are written for. */
  baseServings: number;
  ingredients: RecipeIngredient[];
  steps: RecipeStep[];
  substitutions: Substitution[];
  /**
   * Big-9 allergen keys present, per the deterministic layer (NOT the model).
   * Authored sample metadata in the mock build; an IPC scan result in the app.
   */
  allergens: string[];
}

/**
 * Linearly scale ingredient quantities to `targetServings`. Non-linear
 * quantities (`scalesLinearly === false`) are left untouched — the persona
 * tells the assistant to apply judgement to salt/leavening/etc rather than
 * multiply. Exact arithmetic; display rounding is the widget's job (mirrors the
 * deterministic `convert_units` contract). Steps are unchanged by scaling.
 */
export function scaleRecipe(recipe: Recipe, targetServings: number): Recipe {
  const safeTarget = Math.max(1, Math.round(targetServings));
  const factor = safeTarget / recipe.baseServings;
  return {
    ...recipe,
    baseServings: safeTarget,
    ingredients: recipe.ingredients.map((ing) => ({
      ...ing,
      qty: ing.qty === undefined ? undefined : ing.scalesLinearly ? round2(ing.qty * factor) : ing.qty,
    })),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** The demo recipe behind the H1/H3 happy path ("Help me cook carbonara for 4"). */
export const SAMPLE_CARBONARA: Recipe = {
  title: 'Spaghetti Carbonara',
  baseServings: 4,
  ingredients: [
    { name: 'Spaghetti', qty: 400, unit: 'g', scalesLinearly: true },
    { name: 'Guanciale (or pancetta)', qty: 150, unit: 'g', scalesLinearly: true },
    { name: 'Egg yolks', qty: 4, scalesLinearly: true },
    { name: 'Whole egg', qty: 1, scalesLinearly: true },
    { name: 'Pecorino Romano, grated', qty: 50, unit: 'g', scalesLinearly: true },
    { name: 'Black pepper', scalesLinearly: false },
    { name: 'Salt (for pasta water)', scalesLinearly: false },
  ],
  steps: [
    { number: 1, text: 'Bring a large pot of well-salted water to a boil.' },
    { number: 2, text: 'Add the spaghetti and cook until al dente.', timer: { label: 'Pasta', durationSec: 9 * 60 } },
    { number: 3, text: 'Meanwhile, crisp the guanciale in a cold, dry pan over medium heat.', timer: { label: 'Crisp guanciale', durationSec: 6 * 60 } },
    { number: 4, text: 'Whisk egg yolks + whole egg with the pecorino and plenty of black pepper.' },
    { number: 5, text: 'Toss drained pasta with the guanciale off the heat, then the egg mix, loosening with pasta water until glossy. Do NOT scramble the eggs.' },
  ],
  substitutions: [
    { ingredient: 'Guanciale', swap: 'Pancetta, or thick-cut bacon', ratio: '1:1 by weight (bacon adds smoke)' },
    { ingredient: 'Pecorino Romano', swap: 'Parmigiano-Reggiano', ratio: '1:1 (milder, less salty — taste before adding salt)' },
    { ingredient: '1 whole egg', swap: 'None safe for a raw-egg-averse guest', ratio: 'Cook to 71°C/160°F custard-style off-heat; do not serve visibly raw' },
  ],
  // Present per the deterministic layer: eggs (yolks/whole egg), milk (pecorino
  // = cheese), wheat (spaghetti). NOT computed in TS — see file header.
  allergens: ['eggs', 'milk', 'wheat'],
};
