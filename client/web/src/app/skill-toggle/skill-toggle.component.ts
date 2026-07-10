import { Inject, Component, computed, signal } from '@angular/core';
import { IPC_PORT, IpcPort } from '../ipc/ipc.port';
import { SessionService } from '../state/session.service';
import { TelemetryService } from '../state/telemetry.service';

const SKILL_ID = 'kitchen-timer' as const;

/**
 * The H1 test surface (PHASE0-PLAN §3.4): one toggle that injects the
 * skill persona, registers its tools with the router, and mounts its
 * panels — "install a skill, the app becomes a specialist." Panel
 * mount/unmount + the enter/exit animation live in `app.component` via
 * `PanelDockComponent`; this component owns only the enable/disable
 * lifecycle (IPC calls, session state, telemetry, the persona system line).
 */
@Component({
  selector: 'app-skill-toggle',
  standalone: true,
  templateUrl: './skill-toggle.component.html',
  styleUrl: './skill-toggle.component.css',
})
export class SkillToggleComponent {
  readonly enabled = computed(() => this.session.kitchenSkillEnabled());
  readonly busy = signal(false);

  constructor(
    @Inject(IPC_PORT) private readonly ipc: IpcPort,
    private readonly session: SessionService,
    private readonly telemetry: TelemetryService
  ) {}

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
}
