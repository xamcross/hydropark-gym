import { TestBed } from '@angular/core/testing';
import { TelemetryService } from './telemetry.service';
import { IPC_PORT, IpcPort } from '../ipc/ipc.port';

describe('TelemetryService.tour', () => {
  let logged: any[];
  beforeEach(() => {
    logged = [];
    const fakeIpc: Partial<IpcPort> = {
      invoke: (cmd: string, args: any) => { if (cmd === 'telemetry_log') logged.push(args); return Promise.resolve(undefined as any); },
      on: () => () => {},
    };
    TestBed.configureTestingModule({ providers: [{ provide: IPC_PORT, useValue: fakeIpc }] });
  });

  it('emits a tour event with action and step', () => {
    const svc = TestBed.inject(TelemetryService);
    svc.tour('start', 1);
    const ev = logged.find((e) => e.event === 'tour');
    expect(ev).toBeTruthy();
    expect(ev.action).toBe('start');
    expect(ev.step).toBe(1);
    expect(typeof ev.session_id).toBe('string');
  });
});
