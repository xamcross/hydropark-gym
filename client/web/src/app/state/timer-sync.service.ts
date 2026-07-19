import { Inject, Injectable, OnDestroy } from '@angular/core';
import { IPC_PORT, IpcPort, Unlisten } from '../ipc/ipc.port';
import { SessionService } from './session.service';

/**
 * Keeps Angular's `timers` signal in sync with the countdown Rust owns
 * (SPEC §6 "Rust core owns … timers" — see IPC-CONTRACT.md). The webview
 * never runs its own countdown loop; it only reflects `timer://tick` /
 * `timer://finished` / `timer://updated` events.
 *
 * The `to_chat` system line for a finished timer (SPEC §9.3 point 4) is
 * POSTED BY THE WIDGET now, through the per-agent bus (`TimerStackComponent`,
 * Task 13) — not here. Duplicating it here would double-post: a composed
 * agent's `timer_stack` panel and this app-wide service both observe every
 * `timer://finished` event, and (in this app's current flow) enabling a
 * timer-capable skill enables BOTH the legacy panel and the composed one at
 * once. This service still fires the OS notification directly — the bus's
 * notifier seam (`BUS_NOTIFIER`) is not wired anywhere yet, so keeping it here
 * is the only real notify path and does not risk a double notification.
 *
 * Instantiated once, eagerly, from `AppComponent` (a `providedIn: 'root'`
 * service otherwise only spins up on first injection).
 */
@Injectable({ providedIn: 'root' })
export class TimerSyncService implements OnDestroy {
  private readonly unlisten: Unlisten[];

  constructor(@Inject(IPC_PORT) private readonly ipc: IpcPort, private readonly session: SessionService) {
    this.unlisten = [
      this.ipc.on('timer://tick', (e) => this.session.patchTimerRemaining(e.timer_id, e.remaining_sec)),
      this.ipc.on('timer://updated', (snap) => this.session.upsertTimer(snap)),
      this.ipc.on('timer://finished', (e) => {
        this.session.patchTimerRemaining(e.timer_id, 0);
        void this.ipc.invoke('notify', {
          title: 'Timer finished',
          body: `${e.label} timer is done`,
          sound: true,
        });
      }),
    ];
  }

  ngOnDestroy(): void {
    this.unlisten.forEach((fn) => fn());
  }
}
