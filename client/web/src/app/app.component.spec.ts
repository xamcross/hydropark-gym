import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AppComponent } from './app.component';
import { IPC_PORT } from './ipc/ipc.port';
import { MockIpcService } from './ipc/mock-ipc.service';
import { CompositionService } from './composition/composition.service';
import { ComposeError, ComposedAgentView } from './ipc/contract';
import { SessionService } from './state/session.service';

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

/**
 * W04 — the assistant view used to render the timer/ingredient/unit panels
 * TWICE: once in the main, self-sourced panel dock (`app-panel-dock`, wired
 * straight to `SessionService`/`ToolsService` — the one the user actually
 * edits) and again inside the "Composed agent" inspector column
 * (`app-composed-panel-host`), which mounted its own copy through a nested
 * `app-layout-dock` bound to a per-agent bus that nothing in the UI-first
 * interaction path ever writes to — so the second copy stayed empty and
 * unsynced. Fixed by making the composed-agent column an inspector only (see
 * `composed-panel-host.component.ts`'s class doc). This test drives the whole
 * assistant shell (both columns together) and asserts each interactive widget
 * type appears EXACTLY ONCE — proving the duplicate is gone, not just that one
 * side or the other renders it.
 *
 * `CompositionService` is swapped for a fully synchronous fake (same
 * technique `composed-panel-host.component.spec.ts` uses) so the assertion
 * doesn't depend on the real `compose_agent` IPC round-trip or on driving
 * `fixture.whenStable()` through the main dock's rAF-animated mount — both are
 * exercised elsewhere; this test isolates the one thing it needs to prove.
 */
describe('AppComponent — no duplicate interactive skill panels (W04)', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [{ provide: IPC_PORT, useClass: MockIpcService }],
    }).compileComponents();
  });

  function mount() {
    const fakeComposition: Partial<CompositionService> = {
      composed: signal<ComposedAgentView | null>({
        order: ['kitchen-timer'],
        primary: 'kitchen-timer',
        persona: 'You are the Hydropark Kitchen Timer & Units helper.',
        tools: [{ call_name: 'start_timer', tool_ref: 'start_timer', namespaced: false, contributors: ['kitchen-timer'] }],
        routing: [],
        capacity: { ctx_window: 4096, reserve_tokens: 0, skill_tokens: 200, used_tokens: 200, remaining: 3896, blocked: false, overflow: 0 },
      }),
      error: signal<ComposeError | null>(null),
      composing: signal(false),
      hasAgent: signal(true),
      panels: signal([]),
      slots: signal([]),
      enabledManifests: signal([]),
    };
    TestBed.overrideProvider(CompositionService, { useValue: fakeComposition });
    const fixture = TestBed.createComponent(AppComponent);
    const session = TestBed.inject(SessionService);
    session.kitchenSkillEnabled.set(true);
    fixture.detectChanges();
    return fixture;
  }

  it('renders exactly one timer/ingredients/units widget across the whole assistant view', () => {
    const fixture = mount();
    const compiled = fixture.nativeElement as HTMLElement;

    expect(compiled.querySelectorAll('app-timer-stack').length).toBe(1);
    expect(compiled.querySelectorAll('app-editable-list').length).toBe(1);
    expect(compiled.querySelectorAll('app-segmented-toggle').length).toBe(1);
    // No nested panel-arrangement engine anywhere — that was the mechanism the
    // composed-agent column used to mount the duplicate copy through.
    expect(compiled.querySelector('app-layout-dock')).toBeNull();
  });

  it('the composed-agent inspector still shows persona/tools/context alongside the single interactive panel set', () => {
    const fixture = mount();
    const compiled = fixture.nativeElement as HTMLElement;

    const inspector = compiled.querySelector('.compose-region');
    expect(inspector).withContext('composed agent column should render').toBeTruthy();
    expect(inspector!.textContent).toContain('Composed agent');
    expect(inspector!.textContent).toContain('lead:');
    expect(inspector!.textContent).toContain('kitchen-timer');
    expect(inspector!.querySelector('.ch-persona')).toBeTruthy();
    expect(inspector!.querySelector('.ch-tool')?.textContent?.trim()).toBe('start_timer');
    // ...but no interactive widget lives inside the inspector column.
    expect(inspector!.querySelector('app-timer-stack')).toBeNull();
    expect(inspector!.querySelector('app-editable-list')).toBeNull();
  });
});
