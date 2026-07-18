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
 * W09 — "+ Timer" must OPEN the duration-entry form, not instantly create a
 * fixed-duration timer (user report, verbatim: "additional timers are set to
 * 5 minutes without any way to set the needed time period").
 *
 * This replaces the OLD→NEW contract from W03:
 *   OLD (W03, now WRONG per the user's report): "+ Timer" was rebound to
 *   `quickAddTimer()`, which unconditionally dispatched
 *   `start_timer({ duration_sec: 300 })` the instant the button was clicked —
 *   no form, no way to choose a duration. That fixed W03's original bug (a
 *   toggling `(click)` that could close the form and discard an in-progress
 *   add, so the widget never reliably grew past one timer) but over-corrected
 *   by removing duration control entirely.
 *   NEW (this suite): "+ Timer" idempotently OPENS the add-form
 *   (`showAddForm.set(true)` — SET, never toggled), so the W03 anti-discard
 *   guarantee still holds: repeated clicks keep the form open and never lose
 *   an in-progress draft or touch existing timers. Only a FORM SUBMIT
 *   (`addTimer()`) actually creates a timer, carrying whatever
 *   label/duration the user entered — never a hardcoded value. Each submit
 *   adds one new, distinct timer; existing timers are never removed or
 *   replaced. "Cancel" closes the form and commits nothing.
 */
describe('TimerStackComponent — "+ Timer" opens the duration form (W09)', () => {
  let ipc: FakeIpc;
  let fixture: ComponentFixture<TimerStackComponent>;
  let session: SessionService;

  function clickAddButton(): void {
    const btn: HTMLButtonElement = fixture.nativeElement.querySelector('button.add-btn');
    btn.click();
  }

  function setDraft(label: string, minutes: number): void {
    fixture.componentInstance.labelDraft.set(label);
    fixture.componentInstance.minutesDraft.set(minutes);
  }

  function clickSubmit(): void {
    const btn: HTMLButtonElement = fixture.nativeElement.querySelector('form.add-form button[type="submit"]');
    btn.click();
  }

  function clickCancel(): void {
    const btn: HTMLButtonElement = fixture.nativeElement.querySelector('form.add-form button[type="button"]');
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

  it('clicking "+ Timer" opens the add-form and creates NO timer yet', () => {
    fixture.detectChanges();
    expect(fixture.componentInstance.showAddForm()).toBe(false);

    clickAddButton();
    fixture.detectChanges();

    expect(fixture.componentInstance.showAddForm()).toBe(true);
    expect(session.timerList().length).toBe(0);
  });

  it('submitting the form with a chosen minutes value creates one timer carrying that exact duration_sec — not a hardcoded 300', async () => {
    fixture.detectChanges();
    clickAddButton();
    fixture.detectChanges();
    setDraft('Rice', 12);
    fixture.detectChanges();

    clickSubmit();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const timers = session.timerList();
    expect(timers.length).toBe(1);
    expect(timers[0].label).toBe('Rice');
    expect(timers[0].duration_sec).toBe(12 * 60);
    expect(timers[0].duration_sec).not.toBe(300);
  });

  it('submitting again after a first add creates a SECOND distinct timer, preserving the first exactly (grows past one, never replaces)', async () => {
    fixture.detectChanges();
    clickAddButton();
    fixture.detectChanges();
    setDraft('Pasta', 9);
    clickSubmit();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const first = session.timerList()[0];

    clickAddButton();
    fixture.detectChanges();
    setDraft('Eggs', 7);
    clickSubmit();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const timers = session.timerList();
    expect(timers.length).toBe(2);
    expect(timers.find((t) => t.timer_id === first.timer_id)).toEqual(first);
    const second = timers.find((t) => t.timer_id !== first.timer_id)!;
    expect(second.label).toBe('Eggs');
    expect(second.duration_sec).toBe(7 * 60);
  });

  it('clicking "+ Timer" repeatedly keeps the form open and does NOT discard the in-progress draft (W03 anti-toggle guarantee)', () => {
    fixture.detectChanges();
    clickAddButton();
    fixture.detectChanges();
    setDraft('Bread', 20);
    fixture.detectChanges();

    clickAddButton();
    fixture.detectChanges();
    clickAddButton();
    fixture.detectChanges();

    expect(fixture.componentInstance.showAddForm()).toBe(true);
    expect(fixture.componentInstance.labelDraft()).toBe('Bread');
    expect(fixture.componentInstance.minutesDraft()).toBe(20);
    expect(session.timerList().length).toBe(0);
  });

  it('"Cancel" closes the form and creates no timer', async () => {
    fixture.detectChanges();
    clickAddButton();
    fixture.detectChanges();
    setDraft('Soup', 15);
    fixture.detectChanges();

    clickCancel();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance.showAddForm()).toBe(false);
    expect(session.timerList().length).toBe(0);
  });

  it('never removes an existing timer when "+ Timer" is clicked while the form is already open (model prefill in flight)', async () => {
    session.upsertTimer({ timer_id: 'existing-1', label: 'Pasta', duration_sec: 540, remaining_sec: 300, running: true });
    fixture.componentInstance.showAddForm.set(true);
    fixture.detectChanges();

    clickAddButton();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance.showAddForm()).toBe(true);
    const timers = session.timerList();
    expect(timers.length).toBe(1);
    expect(timers[0]).toEqual({ timer_id: 'existing-1', label: 'Pasta', duration_sec: 540, remaining_sec: 300, running: true });
  });
});
