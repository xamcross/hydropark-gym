import { TestBed } from '@angular/core/testing';
import { TelemetryService } from './telemetry.service';
import { IPC_PORT, IpcPort, Unlisten } from '../ipc/ipc.port';
import { IpcCommand, IpcCommandMap, IpcEvent } from '../ipc/contract';

/** localStorage key TelemetryService uses for the `first_session` marker. */
const PRIOR_SESSION_KEY = 'hydropark.telemetry.prior-session.v1';

/** An `IpcPort` that records every `telemetry_log` envelope and no-ops the rest. */
class CapturingIpc extends IpcPort {
  readonly logged: Record<string, unknown>[] = [];

  invoke<K extends IpcCommand>(cmd: K, args: IpcCommandMap[K]['args']): Promise<IpcCommandMap[K]['result']> {
    if (cmd === 'telemetry_log') this.logged.push(args as unknown as Record<string, unknown>);
    return Promise.resolve(undefined as IpcCommandMap[K]['result']);
  }

  on<K extends IpcEvent>(): Unlisten {
    return () => undefined;
  }
}

describe('TelemetryService (P1-25.1 product metrics)', () => {
  let ipc: CapturingIpc;
  let telemetry: TelemetryService;

  const only = (name: string) => ipc.logged.filter((e) => e['event'] === name);

  beforeEach(() => {
    // Deterministic `first_session`: this test simulates a fresh install.
    try {
      localStorage.removeItem(PRIOR_SESSION_KEY);
    } catch {
      /* storage unavailable in this runner — the service degrades to false */
    }
    ipc = new CapturingIpc();
    TestBed.configureTestingModule({
      providers: [{ provide: IPC_PORT, useValue: ipc }],
    });
    telemetry = TestBed.inject(TelemetryService);
  });

  it('emits an activation metric on the first skill enabled, once per session', () => {
    telemetry.skillEnabled('kitchen-timer');

    const activations = only('activation');
    expect(activations.length).toBe(1);
    expect(activations[0]['skill_id']).toBe('kitchen-timer');
    expect(activations[0]['first_session']).toBe(true);

    // A second enable still logs `skill_enabled` but NOT a second activation.
    telemetry.skillEnabled('cooking-assistant');
    expect(only('activation').length).toBe(1);
    expect(only('skill_enabled').length).toBe(2);
  });

  it('suppresses ALL emission while telemetry is opted out (P1-10.3 guard)', () => {
    telemetry.setEnabled(false);

    telemetry.skillEnabled('kitchen-timer');
    telemetry.composition(2, false);
    telemetry.sessionEnded();

    expect(ipc.logged.length).toBe(0);

    // Re-enabling resumes emission (the guard is not one-way).
    telemetry.setEnabled(true);
    telemetry.composition(2, false);
    expect(only('composition').length).toBe(1);
  });

  it('emits an anonymized composition metric (counts + boolean only)', () => {
    telemetry.composition(3, true);

    const [ev] = only('composition');
    expect(ev['skills_active']).toBe(3);
    expect(ev['via_template']).toBe(true);
    // No names / prompts / conversation content leak into the envelope.
    expect(Object.keys(ev).sort()).toEqual(
      ['event', 'schema_version', 'session_id', 'skills_active', 'ts_ms', 'via_template'].sort()
    );
  });

  it('emits offline-usage + crash-free session metrics at session end, once', () => {
    telemetry.noteBackendCall();
    telemetry.sessionEnded();

    const offline = only('offline_usage')[0];
    expect(offline['offline']).toBe(false); // a backend call was made
    expect(offline['backend_calls']).toBe(1);

    const crash = only('crash_free_session')[0];
    expect(crash['crash_free']).toBe(true);
    expect(crash['errors']).toBe(0);

    // Idempotent: a second end (e.g. pagehide after an explicit end) is a no-op.
    telemetry.sessionEnded();
    expect(only('offline_usage').length).toBe(1);
    expect(only('crash_free_session').length).toBe(1);
  });

  it('reports offline=true for a session that never touches the backend', () => {
    telemetry.sessionEnded();
    expect(only('offline_usage')[0]['offline']).toBe(true);
    expect(only('offline_usage')[0]['backend_calls']).toBe(0);
  });
});
