import { Inject, Injectable, computed, signal } from '@angular/core';
import { SkillId } from '../../ipc/contract';
import { IPC_PORT, IpcPort } from '../../ipc/ipc.port';
import { ToolsService } from '../../tools/tools.service';
import { TelemetryService } from '../../state/telemetry.service';
import { UnlockService } from '../../unlock/unlock.service';
import { Recipe, RecipeStep, SAMPLE_CARBONARA, scaleRecipe } from './recipe';

const COOKING_SKILL_ID: SkillId = 'cooking-assistant';

/**
 * State + behaviour for the paid Cooking Assistant skill (P0-05.3), kept
 * self-contained in the skill's own directory rather than in the shared
 * `SessionService` (which this change does not own). It:
 *  - holds the paid-SKU gate (`unlocked`, DEFAULT FALSE — the lead's
 *    receipt->unlock flow calls `unlock()`), mirroring the Rust
 *    `cooking_assistant::is_unlocked()` gate;
 *  - holds the enable/disable state that drives the UI transform (the panel
 *    mounts via `PanelDock`, exactly like the free skill);
 *  - owns the recipe-steps affordance: numbered steps, per-step timers (reusing
 *    the existing `start_timer` tool), servings scaling, and "add all to list"
 *    (reusing `list_manage` set_all). No new tool is introduced.
 */
@Injectable({ providedIn: 'root' })
export class CookingAssistantService {
  /**
   * Paid gate. DEFAULT LOCKED. This is a computed VIEW of the single source of
   * truth — {@link UnlockService}, which persists the redeemed state — not its own
   * signal. Previously this was a local `signal(false)`, which meant redeeming a
   * code updated UnlockService but left this service (and the panel) still locked.
   */
  readonly unlocked = computed(() => this.unlockSvc.isUnlocked(COOKING_SKILL_ID));
  /** Whether the skill is currently leading (drives the panel transform). */
  readonly enabled = signal(false);

  readonly servings = signal(SAMPLE_CARBONARA.baseServings);
  readonly currentStepIndex = signal(0);

  /** The recipe scaled to the current servings — the panel renders this. */
  readonly recipe = computed<Recipe>(() => scaleRecipe(SAMPLE_CARBONARA, this.servings()));
  readonly steps = computed<RecipeStep[]>(() => this.recipe().steps);
  readonly currentStep = computed<RecipeStep | null>(() => this.steps()[this.currentStepIndex()] ?? null);

  readonly activeSkillId = computed<SkillId | null>(() => (this.enabled() ? COOKING_SKILL_ID : null));

  constructor(
    @Inject(IPC_PORT) private readonly ipc: IpcPort,
    private readonly tools: ToolsService,
    private readonly telemetry: TelemetryService,
    private readonly unlockSvc: UnlockService
  ) {}

  // --- paid-SKU gate (P0-05.3) ------------------------------------------
  // The gate now lives in UnlockService (the persisted source of truth). These
  // helpers delegate so callers/tests keep working, but there is one state.

  /** Redeem a real unlock code through the shared service. */
  async redeem(code: string) {
    return this.unlockSvc.redeem(code);
  }

  /** Dev/H1 affordance: unlock via a freshly-minted valid code, not a bypass. */
  async unlock(): Promise<void> {
    await this.unlockSvc.devSimulateUnlock();
  }

  lock(): void {
    void this.disable();
  }

  // --- enable / disable (the UI transform) ------------------------------

  async enable(): Promise<boolean> {
    if (!this.unlocked()) return false; // gated — never enable while locked
    await this.ipc.invoke('skill_enable', { skill_id: COOKING_SKILL_ID });
    this.enabled.set(true);
    this.currentStepIndex.set(0);
    this.telemetry.skillEnabled(COOKING_SKILL_ID);
    return true;
  }

  async disable(): Promise<void> {
    if (!this.enabled()) return;
    await this.ipc.invoke('skill_disable', { skill_id: COOKING_SKILL_ID });
    this.enabled.set(false);
    this.telemetry.skillDisabled(COOKING_SKILL_ID);
  }

  // --- recipe-steps affordance ------------------------------------------

  setServings(n: number): void {
    this.servings.set(Math.max(1, Math.round(n)));
  }

  goToStep(index: number): void {
    const clamped = Math.max(0, Math.min(this.steps().length - 1, index));
    this.currentStepIndex.set(clamped);
  }

  nextStep(): void {
    this.goToStep(this.currentStepIndex() + 1);
  }

  prevStep(): void {
    this.goToStep(this.currentStepIndex() - 1);
  }

  /** Start a named timer for a time-bound step — reuses the existing start_timer tool (UI-first, no model round-trip). */
  startStepTimer(step: RecipeStep): void {
    if (!step.timer) return;
    void this.tools.startTimer({ label: step.timer.label, duration_sec: step.timer.durationSec });
  }

  /** Populate the shared ingredient list from the (scaled) recipe — reuses list_manage set_all. */
  addAllToList(): void {
    const items = this.recipe().ingredients.map((ing) => ({
      name: ing.name,
      qty: ing.qty,
      unit: ing.unit,
      checked: false,
    }));
    void this.tools.listManage({ op: 'set_all', items });
  }
}
