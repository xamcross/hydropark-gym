import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TourAnchorDirective } from './tour-anchor.directive';
import { TourService } from './tour.service';
import { IPC_PORT, IpcPort } from '../ipc/ipc.port';

@Component({
  standalone: true,
  imports: [TourAnchorDirective],
  template: `@if (show) {<span tourAnchor="chat">hi</span>}`,
})
class HostComponent { show = true; }

describe('TourAnchorDirective', () => {
  let ipc: Partial<IpcPort>;
  beforeEach(() => {
    ipc = { invoke: () => Promise.resolve(undefined as any), on: () => () => {} };
    TestBed.configureTestingModule({ imports: [HostComponent], providers: [{ provide: IPC_PORT, useValue: ipc }] });
  });

  it('registers its element on init and unregisters on destroy', () => {
    const svc = TestBed.inject(TourService);
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    expect(svc.resolve('chat')).not.toBeNull();

    fixture.componentInstance.show = false;
    fixture.detectChanges();
    expect(svc.resolve('chat')).toBeNull();
  });
});
