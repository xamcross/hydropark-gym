import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SessionService, TimerViewState } from '../../state/session.service';
import { ToolsService } from '../../tools/tools.service';
import { InferenceService } from '../../inference/inference.service';

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

  constructor(private readonly session: SessionService, private readonly tools: ToolsService, inference: InferenceService) {
    inference.onPrefillRequest((widget, args) => {
      if (widget !== 'timer_stack') return;
      const a = args as { label?: string; duration_sec?: number };
      this.showAddForm.set(true);
      if (a.label) this.labelDraft.set(a.label);
      if (a.duration_sec) this.minutesDraft.set(Math.round(a.duration_sec / 60));
    });
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

  // --- UI-first trigger (P0-03.6): direct tool call, no model round-trip ---
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
