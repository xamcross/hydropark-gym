import { TestBed } from '@angular/core/testing';
import { TimerStackComponent } from './timer-stack.component';
import { IPC_PORT, IpcPort, Unlisten } from '../../ipc/ipc.port';
import { IpcCommand, IpcCommandMap, IpcEvent, IpcEventMap } from '../../ipc/contract';
import { SessionService } from '../../state/session.service';
import { InferenceService } from '../../inference/inference.service';
import { BUS_TRANSCRIPT_SINK, BusService, BusTranscriptSink, TranscriptLine } from '../../shared/bus';

/** `IpcPort` test double that records `on()` handlers so a test can fire them directly. */
class FakeIpc extends IpcPort {
  private readonly handlers = new Map<IpcEvent, Set<(payload: unknown) => void>>();

  invoke<K extends IpcCommand>(_cmd: K, _args: IpcCommandMap[K]['args']): Promise<IpcCommandMap[K]['result']> {
    return Promise.resolve(undefined as IpcCommandMap[K]['result']);
  }

  on<K extends IpcEvent>(event: K, handler: (payload: IpcEventMap[K]) => void): Unlisten {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as (payload: unknown) => void);
    return () => set!.delete(handler as (payload: unknown) => void);
  }

  /** Test helper: simulate the Rust core pushing an event. */
  fire<K extends IpcEvent>(event: K, payload: IpcEventMap[K]): void {
    for (const h of this.handlers.get(event) ?? []) h(payload);
  }
}

/**
 * Task 13 — timer-finished as the first real `to_chat` producer (SPEC §9.3 #4).
 * Mounts `TimerStackComponent` with the SAME provider shape
 * `ComposedPanelHostComponent` uses (`BusService` + `BUS_TRANSCRIPT_SINK`
 * forwarding to `SessionService`), then fires the real `timer://finished` IPC
 * event and asserts the resulting system line — through the REAL bus, not a
 * mocked `emitConversationEvent`.
 */
describe('TimerStackComponent — timer_finished to_chat producer (Task 13)', () => {
  let ipc: FakeIpc;

  beforeEach(() => {
    ipc = new FakeIpc();
    TestBed.configureTestingModule({
      imports: [TimerStackComponent],
      providers: [
        { provide: IPC_PORT, useValue: ipc },
        BusService,
        {
          provide: BUS_TRANSCRIPT_SINK,
          useFactory: (session: SessionService): BusTranscriptSink => ({
            append: (line: TranscriptLine) =>
              session.addMessage({ id: line.id, role: 'system', text: line.text, streaming: false }),
          }),
          deps: [SessionService],
        },
      ],
    });
  });

  it('posts "⏱ "<label>" timer finished" as a system ChatMessage when a timer finishes', () => {
    const fixture = TestBed.createComponent(TimerStackComponent);
    fixture.detectChanges();
    const session = TestBed.inject(SessionService);

    ipc.fire('timer://finished', { timer_id: 't1', label: 'Pasta' });

    const messages = session.messages();
    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe('system');
    expect(messages[0].text).toBe('⏱ "Pasta" timer finished');
  });

  it('does NOT trigger InferenceService.send when a timer finishes', () => {
    const fixture = TestBed.createComponent(TimerStackComponent);
    fixture.detectChanges();
    const inference = TestBed.inject(InferenceService);
    const sendSpy = spyOn(inference, 'send');

    ipc.fire('timer://finished', { timer_id: 't2', label: 'Eggs' });

    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('does NOT throw and does NOT post when mounted with no bus (legacy/standalone panel)', () => {
    TestBed.resetTestingModule();
    const bareIpc = new FakeIpc();
    TestBed.configureTestingModule({
      imports: [TimerStackComponent],
      providers: [{ provide: IPC_PORT, useValue: bareIpc }],
    });
    const fixture = TestBed.createComponent(TimerStackComponent);
    expect(() => fixture.detectChanges()).not.toThrow();
    const session = TestBed.inject(SessionService);

    expect(() => bareIpc.fire('timer://finished', { timer_id: 't3', label: 'Rice' })).not.toThrow();
    expect(session.messages().length).toBe(0);
  });
});
