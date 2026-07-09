import { TestBed } from '@angular/core/testing';
import { AppComponent } from './app.component';
import { IPC_PORT } from './ipc/ipc.port';
import { MockIpcService } from './ipc/mock-ipc.service';

describe('AppComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [{ provide: IPC_PORT, useClass: MockIpcService }],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('renders the chat widget and skill toggle', () => {
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('app-chat')).toBeTruthy();
    expect(compiled.querySelector('app-skill-toggle')).toBeTruthy();
  });
});
