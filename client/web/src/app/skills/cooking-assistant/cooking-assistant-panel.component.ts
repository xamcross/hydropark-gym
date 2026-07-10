import { Component } from '@angular/core';
import { CookingAssistantService } from './cooking-assistant.service';
import { RecipeIngredient, RecipeStep } from './recipe';

/**
 * The Cooking Assistant recipe-steps affordance (P0-05.3) — the distinct UI
 * this paid skill mounts when enabled. Walks numbered steps, offers a
 * `start_timer` per time-bound step, scales the recipe to N servings, and can
 * push the ingredient list into the shared `editable_list` via `list_manage`.
 * It carries an always-visible allergen disclaimer; the allergen chips come
 * from the deterministic layer, never the model (see recipe.ts header).
 */
@Component({
  selector: 'app-cooking-assistant-panel',
  standalone: true,
  templateUrl: './cooking-assistant-panel.component.html',
  styleUrl: './cooking-assistant-panel.component.css',
})
export class CookingAssistantPanelComponent {
  constructor(readonly cooking: CookingAssistantService) {}

  /** 'tree_nuts' -> 'Tree nuts'. Display-only; not the allergen detection map. */
  allergenLabel(key: string): string {
    const spaced = key.replace(/_/g, ' ');
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
  }

  qtyLabel(ing: RecipeIngredient): string {
    if (ing.qty === undefined) return 'to taste';
    return ing.unit ? `${ing.qty} ${ing.unit}` : `${ing.qty}`;
  }

  timerLabel(step: RecipeStep): string {
    if (!step.timer) return '';
    const m = Math.round(step.timer.durationSec / 60);
    return `Start “${step.timer.label}” · ${m} min`;
  }

  onServingsInput(value: string): void {
    const n = Number(value);
    if (Number.isFinite(n)) this.cooking.setServings(n);
  }
}
