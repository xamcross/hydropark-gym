import { Inject, Injectable, OnDestroy } from '@angular/core';
import { IPC_PORT, IpcPort, Unlisten } from '../ipc/ipc.port';
import { SessionService } from './session.service';

/**
 * Keeps Angular's `timers` signal in sync with the countdown Rust owns
 * (SPEC §6 "Rust core owns … timers" — see IPC-CONTRACT.md). The webview
 * never runs its own countdown loop; it only reflects `timer://tick` /
 * `timer://finished` / `timer://updated` events.
 *
 * Also implements SPEC §9.3 point 4: posting a widget event appends a
 * system line to the transcript and fires the OS notification — it never
 * triggers inference by itself.
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
        this.session.addMessage({
          id: crypto.randomUUID(),
          role: 'system',
          text: `⏱ ${e.label} timer finished`,
          streaming: false,
        });
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
