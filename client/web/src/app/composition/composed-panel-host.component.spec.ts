import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ComposedPanelHostComponent } from './composed-panel-host.component';
import { CompositionService } from './composition.service';
import { IPC_PORT, IpcPort, Unlisten } from '../ipc/ipc.port';
import { ComposeError, ComposedAgentView, IpcCommand, IpcCommandMap, IpcEvent } from '../ipc/contract';
import { SessionService } from '../state/session.service';
import { InferenceService } from '../inference/inference.service';
import { SlotDescriptor } from '../shared/bus';
import { PanelDescriptor } from '../shared/layout/layout.model';

/** No-op `IpcPort`: resolves every command with `undefined` and never pushes events. */
class NoopIpc extends IpcPort {
  invoke<K extends IpcCommand>(_cmd: K, _args: IpcCommandMap[K]['args']): Promise<IpcCommandMap[K]['result']> {
    return Promise.resolve(undefined as IpcCommandMap[K]['result']);
  }

  on<K extends IpcEvent>(): Unlisten {
    return () => undefined;
  }
}

/**
 * Task 13 — `to_chat` transcript-line bridge (SPEC §9.3 #4). Exercises the
 * REAL production wiring: `BUS_TRANSCRIPT_SINK` provided in
 * `ComposedPanelHostComponent`'s own `providers` array, forwarding through the
 * REAL `BusService.emitConversationEvent` to the REAL `SessionService` — no
 * mocking of `emitConversationEvent` itself.
 */
describe('ComposedPanelHostComponent — to_chat transcript bridge (Task 13)', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ComposedPanelHostComponent],
      providers: [{ provide: IPC_PORT, useValue: new NoopIpc() }],
    });
  });

  it('to_chat:true lands a role:"system" ChatMessage in SessionService.messages()', () => {
    const fixture = TestBed.createComponent(ComposedPanelHostComponent);
    fixture.detectChanges();
    const session = TestBed.inject(SessionService);

    const outcome = fixture.componentInstance.bus.emitConversationEvent({
      dir: 'widget->chat',
      widgetId: 'timer_stack',
      eventName: 'timer_finished',
      to_chat: true,
      line: '⏱ "Pasta" timer finished',
    });

    expect(outcome.appended).toBe(true);
    const messages = session.messages();
    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe('system');
    expect(messages[0].text).toBe('⏱ "Pasta" timer finished');
    expect(messages[0].streaming).toBe(false);
  });

  it('to_chat:false does NOT append a ChatMessage', () => {
    const fixture = TestBed.createComponent(ComposedPanelHostComponent);
    fixture.detectChanges();
    const session = TestBed.inject(SessionService);

    const outcome = fixture.componentInstance.bus.emitConversationEvent({
      dir: 'widget->chat',
      widgetId: 'timer_stack',
      eventName: 'timer_started',
      to_chat: false,
      line: 'should never post',
    });

    expect(outcome.appended).toBe(false);
    expect(session.messages().length).toBe(0);
  });

  it('NEVER triggers InferenceService.send — posting a transcript line must not auto-run inference (SPEC §9.3)', () => {
    const fixture = TestBed.createComponent(ComposedPanelHostComponent);
    fixture.detectChanges();
    const inference = TestBed.inject(InferenceService);
    const sendSpy = spyOn(inference, 'send');

    fixture.componentInstance.bus.emitConversationEvent({
      dir: 'widget->chat',
      widgetId: 'timer_stack',
      eventName: 'timer_finished',
      to_chat: true,
      time_critical: true,
      line: '⏱ "Eggs" timer finished',
    });

    expect(sendSpy).not.toHaveBeenCalled();
  });
});

/**
 * X-A11Y.4 (WCAG 1.4.1) — the capacity-gate readout (`.ch-capacity` /
 * `.ch-capacity-blocked`, composed-panel-host.component.html) must never rely
 * on the red/grey colour class alone to convey "blocked". This locks in that
 * BOTH states already carry the verdict in their own TEXT — "Context
 * overflow: … Disable a skill to fit." vs "Context X / Y tokens · Z free" —
 * so a future edit can't quietly regress it to colour-only.
 *
 * Substitutes a fake `CompositionService` (`hasAgent` deliberately pinned
 * `false`) instead of driving the real IPC `compose_agent` round-trip through
 * an enabled skill: the latter also flips `hasAgent()` true, which mounts the
 * live, rAF-animated panel dock via `PanelTransitionDirective` — a real mount
 * this file's OTHER describe block never exercises either, and which hangs
 * `fixture.whenStable()` under headless Karma (rAF callbacks don't reliably
 * fire in that environment; a pre-existing infra property of that directive,
 * unrelated to this test and out of scope here). Faking the service isolates
 * exactly the piece under test — the capacity paragraph's own markup — and
 * stays fully synchronous.
 */
describe('ComposedPanelHostComponent — capacity meter conveys state by TEXT, not colour alone (X-A11Y.4 · WCAG 1.4.1)', () => {
  function mount(view: ComposedAgentView) {
    const fakeComposition: Partial<CompositionService> = {
      composed: signal<ComposedAgentView | null>(view),
      error: signal<ComposeError | null>(null),
      composing: signal(false),
      hasAgent: signal(false),
      panels: signal([]),
      slots: signal([]),
      enabledManifests: signal([]),
    };
    TestBed.configureTestingModule({
      imports: [ComposedPanelHostComponent],
      providers: [
        { provide: IPC_PORT, useValue: new NoopIpc() },
        { provide: CompositionService, useValue: fakeComposition },
      ],
    });
    const fixture = TestBed.createComponent(ComposedPanelHostComponent);
    fixture.detectChanges();
    return fixture;
  }

  it('blocked: the paragraph names the overflow and the remedy in TEXT, alongside (not instead of) the colour class', () => {
    const fixture = mount({
      order: ['kitchen-timer'],
      primary: 'kitchen-timer',
      persona: '',
      tools: [],
      routing: [],
      capacity: { ctx_window: 4096, reserve_tokens: 0, skill_tokens: 5000, used_tokens: 5000, remaining: 0, blocked: true, overflow: 904 },
    });

    const el = fixture.nativeElement.querySelector('.ch-capacity') as HTMLElement | null;
    expect(el).withContext('capacity readout should render').toBeTruthy();
    expect(el!.classList.contains('ch-capacity-blocked')).toBe(true);
    expect(el!.getAttribute('role')).toBe('alert');
    // The colour-bearing class is never the ONLY signal — the same element's
    // own text names the failure and the remedy (WCAG 1.4.1).
    expect(el!.textContent).toContain('Context overflow');
    expect(el!.textContent).toContain('Disable a skill to fit');
  });

  it('not blocked: the paragraph states the live token budget in TEXT, distinct wording from the blocked case', () => {
    const fixture = mount({
      order: ['kitchen-timer'],
      primary: 'kitchen-timer',
      persona: '',
      tools: [],
      routing: [],
      capacity: { ctx_window: 4096, reserve_tokens: 0, skill_tokens: 800, used_tokens: 800, remaining: 3296, blocked: false, overflow: 0 },
    });

    const el = fixture.nativeElement.querySelector('.ch-capacity') as HTMLElement | null;
    expect(el).withContext('capacity readout should render').toBeTruthy();
    expect(el!.classList.contains('ch-capacity-blocked')).toBe(false);
    expect(el!.textContent).toContain('800');
    expect(el!.textContent).toContain('4096');
    expect(el!.textContent).toContain('3296 free');
    expect(el!.textContent).not.toContain('overflow');
  });
});

/**
 * W04 — the composed-agent column used to ALSO mount its own copy of the live
 * interactive panels (a nested `app-layout-dock` resolving `timer_stack` /
 * `editable_list` / `segmented_toggle` through the widget registry, bound to
 * this component's OWN per-agent bus). That copy never stayed in sync with the
 * main, self-sourced panel dock (`app.component.html`'s `app-panel-dock`) —
 * UI-first edits land on `SessionService` directly, never on this bus — so the
 * copy rendered permanently empty next to the real, populated data. This locks
 * in the fix: `ComposedPanelHostComponent` is a compact INSPECTOR only — it
 * never mounts those widgets, however many panels the composed agent declares
 * — while still surfacing persona / tools / the capacity(context) meter.
 *
 * Uses the same fake-`CompositionService` technique as the X-A11Y.4 block
 * above (full real IPC round-trip is exercised at the app-level dedup test in
 * `app.component.spec.ts` instead — see that file for why).
 */
describe('ComposedPanelHostComponent — no duplicate interactive panels (W04)', () => {
  function mount(hasAgent: boolean) {
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
      hasAgent: signal(hasAgent),
      panels: signal<PanelDescriptor[]>([
        { widgetType: 'timer_stack', id: 'timers', region: 'side', priority: 100, title: 'Timers' },
        { widgetType: 'editable_list', id: 'ingredients', region: 'side', priority: 90, title: 'Ingredients', binding: 'ingredients' },
        { widgetType: 'segmented_toggle', id: 'units', region: 'side', priority: 80, title: 'Units' },
      ]),
      slots: signal<SlotDescriptor[]>([{ slot: 'ingredients', kind: 'list', access: 'read_write', writerOfRecord: 'kitchen-timer' }]),
      enabledManifests: signal([]),
    };
    TestBed.configureTestingModule({
      imports: [ComposedPanelHostComponent],
      providers: [
        { provide: IPC_PORT, useValue: new NoopIpc() },
        { provide: CompositionService, useValue: fakeComposition },
      ],
    });
    const fixture = TestBed.createComponent(ComposedPanelHostComponent);
    fixture.detectChanges();
    return fixture;
  }

  it('never mounts app-layout-dock or the timer/ingredient/unit widgets, even though panels are declared', () => {
    const fixture = mount(true);
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('app-layout-dock')).withContext('no nested panel dock').toBeNull();
    expect(el.querySelector('app-timer-stack')).withContext('no duplicate timers widget').toBeNull();
    expect(el.querySelector('app-editable-list')).withContext('no duplicate ingredients widget').toBeNull();
    expect(el.querySelector('app-segmented-toggle')).withContext('no duplicate units widget').toBeNull();
    // The stale, always-empty summary this bug produced must not appear either.
    expect(el.textContent).not.toContain('0 item(s)');
  });

  it('still shows the inspector — header, lead skill, capacity/context meter, persona, and tool chips', () => {
    const fixture = mount(true);
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('.ch-title')?.textContent).toContain('Composed agent');
    expect(el.querySelector('.ch-status')?.textContent).toContain('lead:');
    expect(el.querySelector('.ch-status')?.textContent).toContain('kitchen-timer');
    expect(el.querySelector('.ch-capacity')?.textContent).toContain('200');
    expect(el.querySelector('.ch-persona')?.textContent).toContain('Assembled persona');
    expect(el.querySelector('.ch-tool')?.textContent?.trim()).toBe('start_timer');
    expect(el.querySelector('.ch-save-btn')).withContext('Save as template button preserved').toBeTruthy();
  });
});
