import { TestBed } from '@angular/core/testing';
import { ChatComponent } from './chat.component';
import { TourService } from '../../tour/tour.service';
import { IPC_PORT, IpcPort } from '../../ipc/ipc.port';

describe('ChatComponent × tour bridge', () => {
  beforeEach(() => {
    const ipc: Partial<IpcPort> = { invoke: () => Promise.resolve(undefined as any), on: () => () => {} };
    TestBed.configureTestingModule({ imports: [ChatComponent], providers: [{ provide: IPC_PORT, useValue: ipc }] });
  });

  it('registers a chat bridge whose prefill sets the composer draft', () => {
    const tour = TestBed.inject(TourService);
    const spy = spyOn(tour, 'registerChat').and.callThrough();
    const f = TestBed.createComponent(ChatComponent);
    f.detectChanges();
    expect(spy).toHaveBeenCalled();
    const bridge = spy.calls.mostRecent().args[0];
    bridge.prefill('Help me cook carbonara for 4');
    expect(f.componentInstance.draft()).toBe('Help me cook carbonara for 4');
  });
});
