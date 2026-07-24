import { ElementRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TourOverlayComponent } from './tour-overlay.component';
import { TourService } from './tour.service';
import { IPC_PORT, IpcPort } from '../ipc/ipc.port';

function mkAnchor(): ElementRef<HTMLElement> {
  const el = document.createElement('div');
  el.getBoundingClientRect = () => ({ x: 10, y: 20, width: 100, height: 40, top: 20, left: 10, right: 110, bottom: 60, toJSON: () => {} }) as DOMRect;
  document.body.appendChild(el);
  return new ElementRef(el);
}

describe('TourOverlayComponent', () => {
  let svc: TourService;
  beforeEach(() => {
    try { localStorage.clear(); } catch {}
    const ipc: Partial<IpcPort> = { invoke: () => Promise.resolve(undefined as any), on: () => () => {} };
    TestBed.configureTestingModule({ imports: [TourOverlayComponent], providers: [{ provide: IPC_PORT, useValue: ipc }] });
    svc = TestBed.inject(TourService);
    for (const id of ['chat', 'panels', 'speed', 'marketplace', 'templates', 'account'] as const) svc.registerAnchor(id, mkAnchor());
  });

  it('renders nothing while inactive', () => {
    const f = TestBed.createComponent(TourOverlayComponent);
    f.detectChanges();
    expect((f.nativeElement as HTMLElement).querySelector('.tour-tooltip')).toBeNull();
  });

  it('renders the step title, counter, and a Skip control when active', () => {
    svc.start(true);
    const f = TestBed.createComponent(TourOverlayComponent);
    f.detectChanges();
    const host = f.nativeElement as HTMLElement;
    expect(host.querySelector('.tour-tooltip')).not.toBeNull();
    expect(host.textContent).toContain('Talk to your agent');
    expect(host.textContent).toContain('Step 1 of 6');
    expect(host.querySelector('[data-act="skip"]')).not.toBeNull();
  });

  it('shows a "Send it" primary on the magic step, "Next" elsewhere', () => {
    svc.start(true);
    const f = TestBed.createComponent(TourOverlayComponent);
    f.detectChanges();
    expect((f.nativeElement as HTMLElement).querySelector('[data-act="send"]')).not.toBeNull();
    svc.next(); // → panels
    f.detectChanges();
    const host = f.nativeElement as HTMLElement;
    expect(host.querySelector('[data-act="send"]')).toBeNull();
    expect(host.querySelector('[data-act="next"]')).not.toBeNull();
  });

  it('Escape skips the tour', () => {
    svc.start(true);
    const f = TestBed.createComponent(TourOverlayComponent);
    f.detectChanges();
    const dialog = (f.nativeElement as HTMLElement).querySelector('.tour-tooltip') as HTMLElement;
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    f.detectChanges();
    expect(svc.active()).toBeFalse();
  });

  it('does not advance when Enter is pressed on an action button (native activation, no hijack)', () => {
    svc.start(true);
    const f = TestBed.createComponent(TourOverlayComponent);
    f.detectChanges();
    const sendBtn = (f.nativeElement as HTMLElement).querySelector('[data-act="send"]') as HTMLElement;
    expect(sendBtn).not.toBeNull();
    sendBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    f.detectChanges();
    expect(svc.step().id).toBe('chat');
    expect(svc.active()).toBeTrue();
  });

  it('ArrowRight advances to the next step', () => {
    svc.start(true);
    const f = TestBed.createComponent(TourOverlayComponent);
    f.detectChanges();
    const dialog = (f.nativeElement as HTMLElement).querySelector('.tour-tooltip') as HTMLElement;
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    f.detectChanges();
    expect(svc.step().id).toBe('panels');
  });
});
