import { TestBed } from '@angular/core/testing';
import { InferenceService } from './inference.service';
import { SessionService } from '../state/session.service';
import { IPC_PORT, IpcPort, Unlisten } from '../ipc/ipc.port';
import { IpcCommand, IpcCommandMap, IpcEvent, IpcEventMap } from '../ipc/contract';

/**
 * `IpcPort` test double that records `on()` handlers so a test can fire them
 * directly — same idiom as `TimerStackComponent`'s spec's `FakeIpc`
 * (`client/web/src/app/widgets/timer-stack/timer-stack.component.spec.ts`).
 */
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
 * W02a — `inference://tool_call_detected` must render a clean, tidy chat
 * line (never the raw wire JSON), and `inference://token` (streamed prose)
 * must never carry raw tool JSON either — the Rust side now only streams
 * genuine prose as tokens (see `inference.rs`'s `emit_steps`/`parse_generation`
 * hardening), so this locks the Angular-side contract that consumes it.
 */
describe('InferenceService — W02a clean tool-call rendering', () => {
  let ipc: FakeIpc;
  let inference: InferenceService;
  let session: SessionService;

  beforeEach(() => {
    ipc = new FakeIpc();
    TestBed.configureTestingModule({
      providers: [{ provide: IPC_PORT, useValue: ipc }],
    });
    inference = TestBed.inject(InferenceService);
    session = TestBed.inject(SessionService);
  });

  it('renders a valid start_timer tool_call_detected as a tidy system line — no raw braces', () => {
    ipc.fire('inference://tool_call_detected', {
      session_id: 's1',
      raw: '<tool_call>{"name":"start_timer","arguments":{"label":"Carbonara for 4","duration_sec":1800}}</tool_call>',
      tool: 'start_timer',
      parsed_args: { label: 'Carbonara for 4', duration_sec: 1800 },
      valid: true,
    });

    const messages = session.messages();
    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe('system');
    expect(messages[0].text).toBe('⏱ Setting a timer: "Carbonara for 4" — 30:00');
    // no leaked wire syntax of any kind
    expect(messages[0].text).not.toContain('{');
    expect(messages[0].text).not.toContain('}');
    expect(messages[0].text).not.toContain('<tool_call>');
  });

  it('renders a valid convert_units tool_call_detected as a tidy system line', () => {
    ipc.fire('inference://tool_call_detected', {
      session_id: 's1',
      raw: '<tool_call>{"name":"convert_units","arguments":{"domain":"mass","value":1,"from_unit":"kg","to_unit":"g"}}</tool_call>',
      tool: 'convert_units',
      parsed_args: { domain: 'mass', value: 1, from_unit: 'kg', to_unit: 'g' },
      valid: true,
    });

    const messages = session.messages();
    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe('system');
    expect(messages[0].text).toBe('🔁 Converting 1 kg to g');
    expect(messages[0].text).not.toContain('{');
  });

  it('renders a valid list_manage tool_call_detected as a tidy system line', () => {
    ipc.fire('inference://tool_call_detected', {
      session_id: 's1',
      raw: '<tool_call>{"name":"list_manage","arguments":{"op":"set_all","items":[]}}</tool_call>',
      tool: 'list_manage',
      parsed_args: { op: 'set_all', items: [] },
      valid: true,
    });

    expect(session.messages().length).toBe(1);
    expect(session.messages()[0].text).toBe('📝 Updating the ingredient list (set_all)');
  });

  it('does NOT add a chat message for an invalid (repair-attempt) tool_call_detected', () => {
    ipc.fire('inference://tool_call_detected', {
      session_id: 's1',
      raw: '<tool_call>{not valid json',
      tool: null,
      parsed_args: null,
      valid: false,
    });

    expect(session.messages().length).toBe(0);
  });

  it('does NOT add a chat message when tool is null even if valid (no wire ToolName slot, e.g. calculate/date_math today)', () => {
    ipc.fire('inference://tool_call_detected', {
      session_id: 's1',
      raw: '<tool_call>{"name":"calculate","arguments":{"op":"add","operands":[1,2]}}</tool_call>',
      tool: null,
      parsed_args: { op: 'add', operands: [1, 2] },
      valid: true,
    });

    expect(session.messages().length).toBe(0);
  });

  it('inference://token still appends streamed prose to the in-flight assistant message, unaffected by tool_call_detected lines', async () => {
    await inference.send('help me cook carbonara for 4');
    const replyId = session.messages()[1].id; // [user, assistant(placeholder)]

    ipc.fire('inference://tool_call_detected', {
      session_id: 's1',
      raw: '<tool_call>{"name":"start_timer","arguments":{"label":"Pasta","duration_sec":540}}</tool_call>',
      tool: 'start_timer',
      parsed_args: { label: 'Pasta', duration_sec: 540 },
      valid: true,
    });
    ipc.fire('inference://token', { session_id: 's1', seq: 0, token: 'Your ' });
    ipc.fire('inference://token', { session_id: 's1', seq: 1, token: 'pasta timer is running.' });
    ipc.fire('inference://done', { session_id: 's1', tokens_generated: 2, elapsed_ms: 10, tok_per_sec: 20 });

    const assistantMsg = session.messages().find((m) => m.id === replyId)!;
    expect(assistantMsg.text).toBe('Your pasta timer is running.');
    expect(assistantMsg.text).not.toContain('{');
    expect(assistantMsg.streaming).toBe(false);

    // the tool line and the prose reply are two DISTINCT messages — the raw
    // JSON never gets concatenated into the assistant's streamed text.
    const toolLine = session.messages().find((m) => m.role === 'system');
    expect(toolLine?.text).toBe('⏱ Setting a timer: "Pasta" — 09:00');
  });

  it('inference://tool_call_result only updates tool state (widget), never posts a chat message itself', () => {
    ipc.fire('inference://tool_call_result', {
      session_id: 's1',
      tool: 'start_timer',
      result: { timer_id: 'tmr_1', label: 'Pasta', duration_sec: 540, started_at_ms: 0 },
    });

    expect(session.messages().length).toBe(0);
  });
});
