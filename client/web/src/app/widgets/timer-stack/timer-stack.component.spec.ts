import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TimerStackComponent } from './timer-stack.component';
import { IPC_PORT, IpcPort, Unlisten } from '../../ipc/ipc.port';
import { IpcCommand, IpcCommandMap, IpcEvent, IpcEventMap, StartTimerArgs, ToolCallRequest } from '../../ipc/contract';
import { SessionService } from '../../state/session.service';
import { InferenceService } from '../../inference/inference.service';
import { BUS_TRANSCRIPT_SINK, BusService, BusTranscriptSink, TranscriptLine } from '../../shared/bus';

/**
 * `IpcPort` test double that records `on()` handlers so a test can fire them
 * directly, AND executes `tool_call` for `start_timer` for real (minted with
 * a fresh, unique `timer_id` per call — same shape `MockIpcService.startTimer`
 * returns) so `ToolsService.dispatch` really round-trips into
 * `SessionService.upsertTimer`, exactly like the real add flow.
 */
class FakeIpc extends IpcPort {
  private readonly handlers = new Map<IpcEvent, Set<(payload: unknown) => void>>();
  private seq = 0;

  invoke<K extends IpcCommand>(cmd: K, args: IpcCommandMap[K]['args']): Promise<IpcCommandMap[K]['result']> {
    if (cmd === 'tool_call') {
      const req = args as ToolCallRequest;
      if (req.tool === 'start_timer') {
        this.seq += 1;
        const a = req.args as StartTimerArgs;
        return Promise.resolve({
          request_id: req.request_id,
          ok: true,
          tool: 'start_timer',
          result: { timer_id: `t${this.seq}`, label: a.label, duration_sec: a.duration_sec, started_at_ms: Date.now() },
        } as IpcCommandMap[K]['result']);
      }
    }
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

/**
 * W03 — "+ Timer" must always ADD a new named timer, never remove/replace an
 * existing one (SPEC §9.4 `timer_stack`: "one or many named countdown
 * timers"). Root cause of the reported bug: the button's `(click)` toggled
 * `showAddForm` (`showAddForm.set(!showAddForm())`) instead of always
 * driving toward a new timer — a second "+ Timer" tap (e.g. re-tapping to
 * start a second timer while the add-form from the first was still open)
 * CLOSED the form and committed nothing, so the widget never reliably grew
 * past one timer. Fixed by giving "+ Timer" its own handler
 * (`quickAddTimer()`) that unconditionally dispatches a brand-new
 * `start_timer` call — it never reads or clears `showAddForm`.
 */
describe('TimerStackComponent — "+ Timer" button always adds a new timer (W03)', () => {
  let ipc: FakeIpc;
  let fixture: ComponentFixture<TimerStackComponent>;
  let session: SessionService;

  function clickAddButton(): void {
    const btn: HTMLButtonElement = fixture.nativeElement.querySelector('button.add-btn');
    btn.click();
  }

  beforeEach(() => {
    ipc = new FakeIpc();
    TestBed.configureTestingModule({
      imports: [TimerStackComponent],
      providers: [{ provide: IPC_PORT, useValue: ipc }],
    });
    fixture = TestBed.createComponent(TimerStackComponent);
    session = TestBed.inject(SessionService);
  });

  it('clicking "+ Timer" when one timer already exists results in TWO timers — not zero, not one', async () => {
    session.upsertTimer({ timer_id: 'existing-1', label: 'Pasta', duration_sec: 540, remaining_sec: 300, running: true });
    fixture.detectChanges();
    expect(session.timerList().length).toBe(1);

    clickAddButton();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const timers = session.timerList();
    expect(timers.length).toBe(2);
  });

  it('preserves the existing timer exactly (same id/label/duration) after "+ Timer" adds a second', async () => {
    session.upsertTimer({ timer_id: 'existing-1', label: 'Pasta', duration_sec: 540, remaining_sec: 300, running: true });
    fixture.detectChanges();

    clickAddButton();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const existing = session.timerList().find((t) => t.timer_id === 'existing-1');
    expect(existing).toEqual({ timer_id: 'existing-1', label: 'Pasta', duration_sec: 540, remaining_sec: 300, running: true });
  });

  it('the newly-added timer is distinct from the existing one (different id) and never removes it via the toggle path', async () => {
    session.upsertTimer({ timer_id: 'existing-1', label: 'Pasta', duration_sec: 540, remaining_sec: 300, running: true });
    fixture.detectChanges();

    clickAddButton();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const timers = session.timerList();
    expect(timers.some((t) => t.timer_id === 'existing-1')).toBe(true);
    expect(timers.some((t) => t.timer_id !== 'existing-1')).toBe(true);
  });

  it('clicking "+ Timer" repeatedly keeps adding — three clicks from empty yields three timers, none dropped', async () => {
    expect(session.timerList().length).toBe(0);

    for (let i = 0; i < 3; i++) {
      clickAddButton();
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    }

    expect(session.timerList().length).toBe(3);
  });

  it('never removes an existing timer when the add-form happens to already be open (model prefill in flight)', async () => {
    session.upsertTimer({ timer_id: 'existing-1', label: 'Pasta', duration_sec: 540, remaining_sec: 300, running: true });
    fixture.componentInstance.showAddForm.set(true);
    fixture.detectChanges();

    clickAddButton();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const timers = session.timerList();
    expect(timers.length).toBe(2);
    expect(timers.some((t) => t.timer_id === 'existing-1')).toBe(true);
  });
});
