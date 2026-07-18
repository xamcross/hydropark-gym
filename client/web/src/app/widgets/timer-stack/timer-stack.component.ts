import { Component, DestroyRef, Inject, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SessionService, TimerViewState } from '../../state/session.service';
import { ToolsService } from '../../tools/tools.service';
import { InferenceService } from '../../inference/inference.service';
import { IPC_PORT, IpcPort } from '../../ipc/ipc.port';
import { BusService } from '../../shared/bus';

/** "+ Timer" quick-add default duration (5 min) — matches the add-form's own `minutesDraft` default. */
const DEFAULT_QUICK_ADD_DURATION_SEC = 5 * 60;

@Component({
  selector: 'app-timer-stack',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './timer-stack.component.html',
  styleUrl: './timer-stack.component.css',
})
export class TimerStackComponent {
  readonly timers = computed(() => this.session.timerList());

  showAddForm = signal(false);
  labelDraft = signal('');
  minutesDraft = signal(5);

  /**
   * The per-agent bus (SPEC §9.3), present only when this instance is mounted
   * inside a composed agent (`ComposedPanelHostComponent` provides it —
   * `BusService` is NOT `providedIn: 'root'`). Optional because this same
   * component also mounts standalone in the legacy P0 panel, which has no bus
   * — see the class doc on `BusService`.
   */
  private readonly bus = inject(BusService, { optional: true });

  constructor(
    private readonly session: SessionService,
    private readonly tools: ToolsService,
    inference: InferenceService,
    @Inject(IPC_PORT) ipc: IpcPort
  ) {
    inference.onPrefillRequest((widget, args) => {
      if (widget !== 'timer_stack') return;
      const a = args as { label?: string; duration_sec?: number };
      this.showAddForm.set(true);
      if (a.label) this.labelDraft.set(a.label);
      if (a.duration_sec) this.minutesDraft.set(Math.round(a.duration_sec / 60));
    });

    // SPEC §9.3 #4 — timer_finished is a `to_chat`, time-critical widget
    // event: the first real producer of the bus's `to_chat` contract. Posts a
    // system line ('⏱ "<label>" timer finished') through the bus — never
    // directly through SessionService — so it flows through the same seam
    // every future to_chat widget event uses. Posting NEVER runs inference:
    // the bus holds no inference seam at all (see bus.service.ts), so there is
    // no code path from here to InferenceService.send. No-op when this
    // instance has no bus (legacy/standalone mount, see `bus` above).
    const off = ipc.on('timer://finished', (e) => {
      this.bus?.emitConversationEvent({
        dir: 'widget->chat',
        widgetId: 'timer_stack',
        eventName: 'timer_finished',
        to_chat: true,
        time_critical: true,
        line: `⏱ "${e.label}" timer finished`,
      });
    });
    inject(DestroyRef).onDestroy(off);
  }

  formatRemaining(sec: number): string {
    const m = Math.floor(sec / 60)
      .toString()
      .padStart(2, '0');
    const s = Math.floor(sec % 60)
      .toString()
      .padStart(2, '0');
    return `${m}:${s}`;
  }

  progress(t: TimerViewState): number {
    if (t.duration_sec <= 0) return 0;
    return Math.max(0, Math.min(1, t.remaining_sec / t.duration_sec));
  }

  /**
   * The "+ Timer" button (W03 fix). Previously this button TOGGLED the
   * add-form's visibility (`showAddForm.set(!showAddForm())`) — which is
   * fine for revealing the form once, but a second click (e.g. re-tapping
   * "+ Timer" to start a SECOND named timer while the form from the first
   * add was still open, or just an impatient double-tap) closed the form
   * instead of committing anything, discarding the in-progress add. Net
   * effect: the widget never reliably grew past one timer — exactly the
   * "toggle instead of always adding" bug (SPEC §9.4 `timer_stack`: "one or
   * many named countdown timers"). Fixed per this task's first suggested
   * option: "+ Timer" now ALWAYS creates a brand new timer immediately,
   * with a sensible default label/duration — same UI-first, no-model-
   * round-trip `start_timer` dispatch `addTimer()` below uses, just without
   * requiring the form. It never reads or clears `showAddForm`/
   * `labelDraft`/`minutesDraft`, so it can never interfere with — or be
   * confused for — the model's prefill-form flow (`onPrefillRequest`
   * below), which is untouched.
   */
  quickAddTimer(): void {
    const label = `Timer ${this.timers().length + 1}`;
    void this.tools.startTimer({ label, duration_sec: DEFAULT_QUICK_ADD_DURATION_SEC });
  }

  // --- UI-first trigger (P0-03.6): direct tool call, no model round-trip ---
  // Submits the add-form (opened either by the model's prefill request, per
  // `onPrefillRequest` above, or left over from a prior prefill) with a
  // caller-chosen label/duration. NOT bound to "+ Timer" — see
  // `quickAddTimer()` above.
  addTimer(): void {
    const label = this.labelDraft().trim() || 'Timer';
    const duration_sec = Math.max(1, Math.round(this.minutesDraft() * 60));
    void this.tools.startTimer({ label, duration_sec });
    this.labelDraft.set('');
    this.minutesDraft.set(5);
    this.showAddForm.set(false);
  }

  toggleRunning(t: TimerViewState): void {
    if (t.running) void this.tools.pauseTimer(t.timer_id);
    else void this.tools.resumeTimer(t.timer_id);
  }

  reset(t: TimerViewState): void {
    void this.tools.resetTimer(t.timer_id);
  }
}
