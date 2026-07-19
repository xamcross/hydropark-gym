import { Component, Inject, OnInit, computed, signal } from '@angular/core';
import { ChatComponent } from './widgets/chat/chat.component';
import { TimerStackComponent } from './widgets/timer-stack/timer-stack.component';
import { EditableListComponent } from './widgets/editable-list/editable-list.component';
import { SegmentedToggleComponent } from './widgets/segmented-toggle/segmented-toggle.component';
import { SkillToggleComponent } from './skill-toggle/skill-toggle.component';
import { InstalledSkillsComponent } from './installed-skills/installed-skills.component';
import { UnlockComponent } from './unlock/unlock.component';
import { PanelDockComponent } from './shared/panel-dock/panel-dock.component';
import { CookingAssistantPanelComponent } from './skills/cooking-assistant/cooking-assistant-panel.component';
import { CookingAssistantService } from './skills/cooking-assistant/cooking-assistant.service';
import { ComposedPanelHostComponent } from './composition/composed-panel-host.component';
import { MarketplaceViewComponent } from './marketplace/marketplace-view.component';
import { AccountMenuComponent } from './account/account-menu.component';
import { UpdateCheckComponent } from './update-check/update-check.component';
import { ToastHostComponent } from './shared/notify/toast-host.component';
import { HardwareWarningComponent } from './hardware-warning/hardware-warning.component';
import { OnboardingOverlayComponent } from './onboarding/onboarding-overlay.component';
import { OnboardingService } from './onboarding/onboarding.service';
import { SessionService } from './state/session.service';
import { TelemetryService } from './state/telemetry.service';
import { TimerSyncService } from './state/timer-sync.service';
import { IPC_PORT, IpcPort } from './ipc/ipc.port';
import { MockIpcService } from './ipc/mock-ipc.service';
import { ThemeService } from './shared/theme.service';
import { TemplatesGalleryComponent } from './templates/templates-gallery.component';

/** Which top-level surface the shell shows. */
type ShellView = 'assistant' | 'marketplace' | 'templates';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    ChatComponent,
    TimerStackComponent,
    EditableListComponent,
    SegmentedToggleComponent,
    SkillToggleComponent,
    InstalledSkillsComponent,
    UnlockComponent,
    PanelDockComponent,
    CookingAssistantPanelComponent,
    ComposedPanelHostComponent,
    MarketplaceViewComponent,
    AccountMenuComponent,
    UpdateCheckComponent,
    ToastHostComponent,
    HardwareWarningComponent,
    OnboardingOverlayComponent,
    TemplatesGalleryComponent,
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
})
export class AppComponent implements OnInit {
  readonly title = 'Hydropark — Phase 0 Prototype';
  readonly skillEnabled = computed(() => this.session.kitchenSkillEnabled());
  /** Paid Cooking Assistant enablement — mirrors `SkillToggleComponent`'s own
   *  `cookingEnabled`, so its recipe panel mounts in the SAME layout panel lane
   *  as the free skill's panels (see app.component.html). */
  readonly cookingEnabled = computed(() => this.cooking.enabled());

  /** Active top-level surface (Assistant/Compose vs Marketplace). Default: Assistant. */
  readonly view = signal<ShellView>('assistant');
  /** True when running against the in-browser mock (no Tauri shell) — gates the dev-only telemetry download affordance. */
  readonly isMock: boolean;
  /** Rendered theme (resolves the OS default when the user has made no explicit choice). */
  readonly theme = computed(() => this.themeSvc.preference() ?? this.themeSvc.resolved());

  constructor(
    @Inject(IPC_PORT) private readonly ipc: IpcPort,
    private readonly session: SessionService,
    private readonly cooking: CookingAssistantService,
    private readonly telemetry: TelemetryService,
    private readonly themeSvc: ThemeService,
    // Injected solely to activate its constructor side effects (timer event
    // subscriptions) at app start — see timer-sync.service.ts.
    private readonly timerSync: TimerSyncService,
    // First-run onboarding (P1-11.4). Its constructor resolves the resettable
    // first-run flag and auto-opens the overlay on a fresh install.
    readonly onboarding: OnboardingService
  ) {
    this.isMock = ipc instanceof MockIpcService;
  }

  /** Dev affordance: replay the first-run onboarding (resettable flag). Mock-only. */
  replayOnboarding(): void {
    this.onboarding.restart();
  }

  toggleTheme(): void {
    this.themeSvc.toggle();
  }

  setView(view: ShellView): void {
    this.view.set(view);
  }

  /** A template finished loading successfully (Task 11b) — bring the user to see the composed result. */
  onTemplateLoaded(): void {
    this.setView('assistant');
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
    // Flush the session-level product metrics (offline-usage share + crash-free
    // session). Idempotent with the `pagehide` flush inside TelemetryService.
    this.telemetry.sessionEnded();
  }
}
