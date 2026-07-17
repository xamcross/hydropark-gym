import { TestBed } from '@angular/core/testing';
import { ComposedPanelHostComponent } from './composed-panel-host.component';
import { IPC_PORT, IpcPort, Unlisten } from '../ipc/ipc.port';
import { IpcCommand, IpcCommandMap, IpcEvent } from '../ipc/contract';
import { SessionService } from '../state/session.service';
import { InferenceService } from '../inference/inference.service';

/** No-op `IpcPort`: resolves every command with `undefined` and never pushes events. */
class NoopIpc extends IpcPort {
  invoke<K extends IpcCommand>(_cmd: K, _args: IpcCommandMap[K]['args']): Promise<IpcCommandMap[K]['result']> {
    return Promise.resolve(undefined as IpcCommandMap[K]['result']);
  }

  on<K extends IpcEvent>(): Unlisten {
    return () => undefined;
  }
}

/**
 * Task 13 — `to_chat` transcript-line bridge (SPEC §9.3 #4). Exercises the
 * REAL production wiring: `BUS_TRANSCRIPT_SINK` provided in
 * `ComposedPanelHostComponent`'s own `providers` array, forwarding through the
 * REAL `BusService.emitConversationEvent` to the REAL `SessionService` — no
 * mocking of `emitConversationEvent` itself.
 */
describe('ComposedPanelHostComponent — to_chat transcript bridge (Task 13)', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ComposedPanelHostComponent],
      providers: [{ provide: IPC_PORT, useValue: new NoopIpc() }],
    });
  });

  it('to_chat:true lands a role:"system" ChatMessage in SessionService.messages()', () => {
    const fixture = TestBed.createComponent(ComposedPanelHostComponent);
    fixture.detectChanges();
    const session = TestBed.inject(SessionService);

    const outcome = fixture.componentInstance.bus.emitConversationEvent({
      dir: 'widget->chat',
      widgetId: 'timer_stack',
      eventName: 'timer_finished',
      to_chat: true,
      line: '⏱ "Pasta" timer finished',
    });

    expect(outcome.appended).toBe(true);
    const messages = session.messages();
    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe('system');
    expect(messages[0].text).toBe('⏱ "Pasta" timer finished');
    expect(messages[0].streaming).toBe(false);
  });

  it('to_chat:false does NOT append a ChatMessage', () => {
    const fixture = TestBed.createComponent(ComposedPanelHostComponent);
    fixture.detectChanges();
    const session = TestBed.inject(SessionService);

    const outcome = fixture.componentInstance.bus.emitConversationEvent({
      dir: 'widget->chat',
      widgetId: 'timer_stack',
      eventName: 'timer_started',
      to_chat: false,
      line: 'should never post',
    });

    expect(outcome.appended).toBe(false);
    expect(session.messages().length).toBe(0);
  });

  it('NEVER triggers InferenceService.send — posting a transcript line must not auto-run inference (SPEC §9.3)', () => {
    const fixture = TestBed.createComponent(ComposedPanelHostComponent);
    fixture.detectChanges();
    const inference = TestBed.inject(InferenceService);
    const sendSpy = spyOn(inference, 'send');

    fixture.componentInstance.bus.emitConversationEvent({
      dir: 'widget->chat',
      widgetId: 'timer_stack',
      eventName: 'timer_finished',
      to_chat: true,
      time_critical: true,
      line: '⏱ "Eggs" timer finished',
    });

    expect(sendSpy).not.toHaveBeenCalled();
  });
});
