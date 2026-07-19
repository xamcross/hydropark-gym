import { Inject, Component, computed, signal } from '@angular/core';
import { IPC_PORT, IpcPort } from '../ipc/ipc.port';
import { MockIpcService } from '../ipc/mock-ipc.service';
import { SessionService } from '../state/session.service';
import { TelemetryService } from '../state/telemetry.service';
import { CookingAssistantService } from '../skills/cooking-assistant/cooking-assistant.service';

const SKILL_ID = 'kitchen-timer' as const;

/**
 * The skill enable surface. Hosts BOTH Phase-0 skills (SPEC §26.4):
 *  - the free "Kitchen Timer & Units" toggle — the H1 transform surface
 *    (PHASE0-PLAN §3.4), unchanged: it injects the persona, registers the
 *    tools, and mounts its panels (via app.component's PanelDock).
 *  - the paid "Cooking Assistant" toggle (P0-05.3) — the $5 H3 SKU. Gated
 *    behind `CookingAssistantService.unlocked` (DEFAULT LOCKED, driven by the
 *    lead's receipt->unlock flow); shows a locked state until unlocked. When
 *    enabled it mounts the recipe-steps panel with the SAME PanelDock enter/exit
 *    transform, so it "feels like a different tool" — the H1 payload for the
 *    paid skill.
 *
 * A dev-only "simulate unlock" affordance appears when running against the
 * in-browser mock, so the transform is demonstrable before the real unlock
 * flow exists — it is hidden in a real Tauri build.
 */
@Component({
  selector: 'app-skill-toggle',
  standalone: true,
  imports: [],
  templateUrl: './skill-toggle.component.html',
  styleUrl: './skill-toggle.component.css',
})
export class SkillToggleComponent {
  readonly enabled = computed(() => this.session.kitchenSkillEnabled());
  readonly busy = signal(false);

  // Paid Cooking Assistant state (self-contained in its own service).
  readonly cookingUnlocked = computed(() => this.cooking.unlocked());
  readonly cookingEnabled = computed(() => this.cooking.enabled());
  readonly cookingBusy = signal(false);
  /** Dev affordance only — hidden in a real Tauri build. */
  readonly isMock: boolean;

  constructor(
    @Inject(IPC_PORT) private readonly ipc: IpcPort,
    private readonly session: SessionService,
    private readonly telemetry: TelemetryService,
    private readonly cooking: CookingAssistantService
  ) {
    this.isMock = ipc instanceof MockIpcService;
  }

  async toggle(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      if (this.enabled()) {
        await this.ipc.invoke('skill_disable', { skill_id: SKILL_ID });
        this.session.kitchenSkillEnabled.set(false);
        this.telemetry.skillDisabled(SKILL_ID);
        this.session.addMessage({
          id: crypto.randomUUID(),
          role: 'system',
          text: '— Kitchen Timer & Units disabled —',
          streaming: false,
        });
      } else {
        await this.ipc.invoke('skill_enable', { skill_id: SKILL_ID });
        this.session.kitchenSkillEnabled.set(true);
        this.telemetry.skillEnabled(SKILL_ID);
        this.session.addMessage({
          id: crypto.randomUUID(),
          role: 'system',
          text: '— Kitchen Timer & Units enabled: timers, an ingredient list, and unit conversion are now available —',
          streaming: false,
        });
      }
    } finally {
      this.busy.set(false);
    }
  }

  // --- paid Cooking Assistant (P0-05.3) ----------------------------------

  async toggleCooking(): Promise<void> {
    if (this.cookingBusy()) return;
    if (!this.cookingUnlocked()) return; // gated — locked SKU cannot be enabled
    this.cookingBusy.set(true);
    try {
      if (this.cookingEnabled()) {
        await this.cooking.disable();
        this.session.addMessage({
          id: crypto.randomUUID(),
          role: 'system',
          text: '— Cooking Assistant disabled —',
          streaming: false,
        });
      } else {
        const ok = await this.cooking.enable();
        if (ok) {
          this.session.addMessage({
            id: crypto.randomUUID(),
            role: 'system',
            text: '— Cooking Assistant enabled: recipe steps, per-step timers, serving scaling, and substitutions are now available —',
            streaming: false,
          });
        }
      }
    } finally {
      this.cookingBusy.set(false);
    }
  }

  /** Dev-only: stand in for the receipt->unlock flow so the transform is demoable. */
  simulateUnlock(): void {
    this.cooking.unlock();
    this.session.addMessage({
      id: crypto.randomUUID(),
      role: 'system',
      text: '— Cooking Assistant unlocked ($5 SKU) — enable it above —',
      streaming: false,
    });
  }
}
