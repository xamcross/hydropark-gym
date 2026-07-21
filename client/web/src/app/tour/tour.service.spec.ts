import { ElementRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TourService } from './tour.service';
import { IPC_PORT, IpcPort } from '../ipc/ipc.port';

function fakeIpc(): Partial<IpcPort> {
  return { invoke: () => Promise.resolve(undefined as any), on: () => () => {} };
}
function anchor(): ElementRef<HTMLElement> {
  const el = document.createElement('div');
  document.body.appendChild(el); // isConnected === true
  return new ElementRef(el);
}

describe('TourService engine', () => {
  let svc: TourService;
  beforeEach(() => {
    try { localStorage.clear(); } catch {}
    TestBed.configureTestingModule({ providers: [{ provide: IPC_PORT, useValue: fakeIpc() }] });
    svc = TestBed.inject(TourService);
    // Register every anchor so navigation never self-skips in these tests.
    for (const id of ['chat', 'panels', 'speed', 'marketplace', 'templates', 'account'] as const) {
      svc.registerAnchor(id, anchor());
    }
  });

  it('does not auto-activate; start(force) opens at step 1', () => {
    expect(svc.active()).toBeFalse();
    svc.start(true);
    expect(svc.active()).toBeTrue();
    expect(svc.stepNumber()).toBe(1);
    expect(svc.step().id).toBe('chat');
  });

  it('next() walks forward and complete()s past the last step, setting the one-time flag', () => {
    svc.start(true);
    for (let i = 0; i < 5; i++) svc.next(); // 1→6
    expect(svc.stepNumber()).toBe(6);
    expect(svc.isLast()).toBeTrue();
    svc.next(); // past last → complete
    expect(svc.active()).toBeFalse();
    // Flag now set: a non-forced start is a no-op.
    svc.start(false);
    expect(svc.active()).toBeFalse();
  });

  it('skip() closes and sets the one-time flag', () => {
    svc.start(true);
    svc.skip();
    expect(svc.active()).toBeFalse();
    svc.start(false);
    expect(svc.active()).toBeFalse();
  });
});

describe('TourService self-skip', () => {
  it('skips an unregistered anchor when advancing', () => {
    try { localStorage.clear(); } catch {}
    TestBed.configureTestingModule({ providers: [{ provide: IPC_PORT, useValue: { invoke: () => Promise.resolve(undefined as any), on: () => () => {} } }] });
    const svc = TestBed.inject(TourService);
    const mk = () => { const el = document.createElement('div'); document.body.appendChild(el); return new ElementRef<HTMLElement>(el); };
    // Register only chat and speed (panels missing) — everything else missing too.
    svc.registerAnchor('chat', mk());
    svc.registerAnchor('speed', mk());
    svc.start(true);
    expect(svc.step().id).toBe('chat');
    svc.next(); // panels missing → should land on 'speed'
    expect(svc.step().id).toBe('speed');
    svc.next(); // nothing resolvable after → complete
    expect(svc.active()).toBeFalse();
  });

  it('start() self-skips an unregistered first step and opens on the first resolvable one', () => {
    try { localStorage.clear(); } catch {}
    TestBed.configureTestingModule({ providers: [{ provide: IPC_PORT, useValue: { invoke: () => Promise.resolve(undefined as any), on: () => () => {} } }] });
    const svc = TestBed.inject(TourService);
    const mk = () => { const el = document.createElement('div'); document.body.appendChild(el); return new ElementRef<HTMLElement>(el); };
    // Register only 'speed' (index 2); 'chat' (0) and 'panels' (1) are unregistered.
    svc.registerAnchor('speed', mk());
    svc.start(true);
    expect(svc.active()).toBeTrue();
    expect(svc.step().id).toBe('speed');
    expect(svc.stepNumber()).toBe(3);
  });

  it('back() self-skips unregistered steps', () => {
    try { localStorage.clear(); } catch {}
    TestBed.configureTestingModule({ providers: [{ provide: IPC_PORT, useValue: { invoke: () => Promise.resolve(undefined as any), on: () => () => {} } }] });
    const svc = TestBed.inject(TourService);
    const mk = () => { const el = document.createElement('div'); document.body.appendChild(el); return new ElementRef<HTMLElement>(el); };
    // Register 'chat' (0), 'speed' (2), 'account' (5); 'panels','marketplace','templates' unregistered.
    svc.registerAnchor('chat', mk());
    svc.registerAnchor('speed', mk());
    svc.registerAnchor('account', mk());
    svc.start(true);   // chat (step 1)
    svc.next();        // skips panels → speed (step 3)
    svc.next();        // skips marketplace, templates → account (step 6)
    expect(svc.step().id).toBe('account');
    svc.back();        // skips templates, marketplace → speed (step 3)
    expect(svc.step().id).toBe('speed');
  });
});
