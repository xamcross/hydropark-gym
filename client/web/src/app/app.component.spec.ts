import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AppComponent } from './app.component';
import { IPC_PORT } from './ipc/ipc.port';
import { MockIpcService } from './ipc/mock-ipc.service';
import { CompositionService } from './composition/composition.service';
import { ComposeError, ComposedAgentView } from './ipc/contract';
import { SessionService } from './state/session.service';
import { CookingAssistantService } from './skills/cooking-assistant/cooking-assistant.service';

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

/**
 * Systematic-debugging fix: "when both Kitchen Timer & Units and Cooking
 * Assistant are enabled, only the latter is seen."
 *
 * ROOT CAUSE: the Cooking Assistant recipe panel was mounted inside
 * `app-skill-toggle`, which sits ABOVE the main flex `.layout` in the shell
 * column. Being a ~1200px-tall block, it pushed the chat region AND the Kitchen
 * Timer panels (which live INSIDE `.layout`) entirely below the viewport — so
 * only the Cooking Assistant was visible. (Confirmed in a real browser: at a
 * 900px viewport the layout was pushed to y≈1474.)
 *
 * FIX: mount the Cooking Assistant panel in the SAME layout side-region lane as
 * the Kitchen Timer panels, self-gated, so neither pushes the other off-screen
 * and the lane scrolls internally. A jsdom unit test can't measure layout, so
 * this asserts the DOM-placement INVARIANT that produced the fix.
 */
describe('AppComponent — both skills share one layout panel lane (no off-screen push)', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [{ provide: IPC_PORT, useClass: MockIpcService }],
    }).compileComponents();
  });

  it('mounts the Cooking Assistant panel INSIDE the main layout side-region (not above it in app-skill-toggle), alongside the Kitchen Timer panels', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const session = TestBed.inject(SessionService);
    const cooking = TestBed.inject(CookingAssistantService);
    session.kitchenSkillEnabled.set(true);
    cooking.enabled.set(true);
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;

    const sideRegion = compiled.querySelector('main.layout .side-region');
    expect(sideRegion).withContext('layout side-region should render when a skill is enabled').toBeTruthy();

    // Both skills' panels live in the SAME shared lane.
    expect(sideRegion!.querySelector('app-timer-stack')).withContext('kitchen panel in the shared lane').toBeTruthy();
    expect(sideRegion!.querySelector('app-cooking-assistant-panel')).withContext('cooking panel in the shared lane').toBeTruthy();

    // The cooking panel must NOT be mounted above the layout inside app-skill-toggle
    // — that placement is exactly what pushed the kitchen panels + chat off-screen.
    const skillToggle = compiled.querySelector('app-skill-toggle');
    expect(skillToggle?.querySelector('app-cooking-assistant-panel'))
      .withContext('cooking panel must not live inside app-skill-toggle')
      .toBeFalsy();

    // Still exactly one of each panel across the whole view (no duplicate mount).
    expect(compiled.querySelectorAll('app-cooking-assistant-panel').length).toBe(1);
    expect(compiled.querySelectorAll('app-timer-stack').length).toBe(1);
  });
});
