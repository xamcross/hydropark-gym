import { Component, Inject, OnInit, computed, signal } from '@angular/core';
import { ChatComponent } from './widgets/chat/chat.component';
import { TimerStackComponent } from './widgets/timer-stack/timer-stack.component';
import { EditableListComponent } from './widgets/editable-list/editable-list.component';
import { SegmentedToggleComponent } from './widgets/segmented-toggle/segmented-toggle.component';
import { SkillToggleComponent } from './skill-toggle/skill-toggle.component';
import { UnlockComponent } from './unlock/unlock.component';
import { PanelDockComponent } from './shared/panel-dock/panel-dock.component';
import { ComposedPanelHostComponent } from './composition/composed-panel-host.component';
import { MarketplaceViewComponent } from './marketplace/marketplace-view.component';
import { ToastHostComponent } from './shared/notify/toast-host.component';
import { SessionService } from './state/session.service';
import { TelemetryService } from './state/telemetry.service';
import { TimerSyncService } from './state/timer-sync.service';
import { IPC_PORT, IpcPort } from './ipc/ipc.port';
import { MockIpcService } from './ipc/mock-ipc.service';
import { ThemeService } from './shared/theme.service';

/** Which top-level surface the shell shows. */
type ShellView = 'assistant' | 'marketplace';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    ChatComponent,
    TimerStackComponent,
    EditableListComponent,
    SegmentedToggleComponent,
    SkillToggleComponent,
    UnlockComponent,
    PanelDockComponent,
    ComposedPanelHostComponent,
    MarketplaceViewComponent,
    ToastHostComponent,
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
})
export class AppComponent implements OnInit {
  readonly title = 'Hydropark — Phase 0 Prototype';
  readonly skillEnabled = computed(() => this.session.kitchenSkillEnabled());

  /** Active top-level surface (Assistant/Compose vs Marketplace). Default: Assistant. */
  readonly view = signal<ShellView>('assistant');
  /** True when running against the in-browser mock (no Tauri shell) — gates the dev-only telemetry download affordance. */
  readonly isMock: boolean;
  /** Rendered theme (resolves the OS default when the user has made no explicit choice). */
  readonly theme = computed(() => this.themeSvc.preference() ?? this.themeSvc.resolved());

  constructor(
    @Inject(IPC_PORT) private readonly ipc: IpcPort,
    private readonly session: SessionService,
    private readonly telemetry: TelemetryService,
    private readonly themeSvc: ThemeService,
    // Injected solely to activate its constructor side effects (timer event
    // subscriptions) at app start — see timer-sync.service.ts.
    private readonly timerSync: TimerSyncService
  ) {
    this.isMock = ipc instanceof MockIpcService;
  }

  toggleTheme(): void {
    this.themeSvc.toggle();
  }

  setView(view: ShellView): void {
    this.view.set(view);
  }

  async ngOnInit(): Promise<void> {
    const hw = await this.ipc.invoke('get_hardware_profile', undefined);
    this.session.hardwareProfile.set(hw);
  }

  downloadLog(): void {
    if (this.ipc instanceof MockIpcService) this.ipc.downloadTelemetryLog();
  }

  endSession(): void {
    this.telemetry.outcome('session_end');
  }
}
