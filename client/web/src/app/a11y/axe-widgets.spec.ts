import { ComponentFixture, TestBed } from '@angular/core/testing';
import axe from 'axe-core';
import { ChatComponent } from '../widgets/chat/chat.component';
import { TimerStackComponent } from '../widgets/timer-stack/timer-stack.component';
import { EditableListComponent } from '../widgets/editable-list/editable-list.component';
import { SegmentedToggleComponent } from '../widgets/segmented-toggle/segmented-toggle.component';
import { KeyValuePanelComponent } from '../widgets/key-value-panel/key-value-panel.component';
import { DateTimePickerComponent } from '../widgets/date-time-picker/date-time-picker.component';
import { QuickActionsComponent } from '../widgets/quick-actions/quick-actions.component';
import { ProgressComponent } from '../widgets/progress/progress.component';
import { IPC_PORT, IpcPort, Unlisten } from '../ipc/ipc.port';
import { IpcCommand, IpcCommandMap, IpcEvent, IpcEventMap } from '../ipc/contract';
import { SessionService } from '../state/session.service';

/* =============================================================================
   X-A11Y.1 — axe-core harness for the DEMO-PATH widget library.
   -----------------------------------------------------------------------------
   Mounts each of the eight demo-path widgets (chat, timer_stack, editable_list,
   segmented_toggle, key_value_panel, date_time_picker, quick_actions, progress)
   in a REALISTIC populated state, in BOTH themes (light/dark — the `hp-theme`
   mechanism, see `shared/theme.service.ts`: an explicit choice is expressed as
   `data-theme="light"|"dark"` on `document.documentElement`; this spec drives
   that attribute directly, exactly as `ThemeService.set()` does), and asserts
   zero SERIOUS/CRITICAL axe-core violations.

   Widgets that inject the standard IPC-backed services (`InferenceService`/
   `ToolsService`/`TelemetryService`, all `providedIn: 'root'`) are mounted with
   the SAME `FakeIpc` + `IPC_PORT` provider shape `timer-stack.component.spec.ts`
   already uses — no bus is provided, matching the "legacy/standalone panel"
   mount those widgets already support. Pure `@Input`/`input()` widgets (no
   injected services) are mounted directly.

   A FRESH component instance is mounted for EACH theme (rather than flipping
   `data-theme` on one already-rendered instance) for two reasons proven while
   building this harness: (1) some widget CSS transitions `background`/
   `border-color` on change, so re-theming a live element risks sampling a
   mid-transition frame; (2) axe-core itself was observed to reuse a stale
   colour-contrast computation when `axe.run()` was called twice in a row
   against the very same DOM node. Mounting fresh sidesteps both — the very
   FIRST paint already reflects the target theme, nothing to transition from,
   and axe never sees a node it scanned before.

   Only `serious`/`critical` impact violations fail the test (per X-A11Y.1's own
   bar); `minor`/`moderate` findings are not gated here.
   ============================================================================= */

/** `IpcPort` test double — resolves every command with `undefined`, never pushes events. Mirrors timer-stack.component.spec.ts's FakeIpc. */
class FakeIpc extends IpcPort {
  invoke<K extends IpcCommand>(_cmd: K, _args: IpcCommandMap[K]['args']): Promise<IpcCommandMap[K]['result']> {
    return Promise.resolve(undefined as IpcCommandMap[K]['result']);
  }

  on<K extends IpcEvent>(_event: K, _handler: (payload: IpcEventMap[K]) => void): Unlisten {
    return () => undefined;
  }
}

type Theme = 'light' | 'dark';
const THEMES: readonly Theme[] = ['light', 'dark'];

/** Drives the SAME `data-theme` attribute `ThemeService.set()` writes (theme.service.ts). */
function setTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
}

/** Back to the no-explicit-choice default (theme.service.ts `clear()`). */
function clearTheme(): void {
  document.documentElement.removeAttribute('data-theme');
}

/** Only these impact levels gate the test (X-A11Y.1 — "zero serious/critical"). */
const GATING_IMPACT = new Set<string>(['serious', 'critical']);

/**
 * Mount a widget (fresh `TestBed` module + component instance), run axe
 * against it, then tear down — once per theme. Always resolves through a real
 * `expect(...)` (so a clean run never trips Jasmine's "no expectations"
 * warning) with a detailed `withContext` message (rule id, impact, offending
 * selector(s)) so a real regression is diagnosable straight from the test
 * output, never a bare "expected true".
 */
async function expectNoSeriousOrCriticalViolations(
  widgetLabel: string,
  mount: () => HTMLElement
): Promise<void> {
  try {
    for (const theme of THEMES) {
      setTheme(theme);
      const el = mount();
      document.body.appendChild(el);
      try {
        const results = await axe.run(el, { resultTypes: ['violations'] });
        const gating = results.violations.filter((v) => GATING_IMPACT.has(v.impact ?? ''));
        const detail = gating
          .map(
            (v) =>
              `  [${v.impact}] ${v.id} — ${v.help}\n` +
              v.nodes.map((n) => `    · ${n.target.join(' ')}: ${n.failureSummary}`).join('\n')
          )
          .join('\n');
        expect(gating.length)
          .withContext(`${widgetLabel} (${theme} theme) serious/critical axe violation(s):\n${detail}`)
          .toBe(0);
      } finally {
        el.remove();
      }
    }
  } finally {
    clearTheme();
  }
}

describe('Widget library — axe-core a11y harness (X-A11Y.1)', () => {
  afterEach(() => {
    clearTheme();
  });

  it('chat: zero serious/critical violations (populated transcript, both themes)', async () => {
    function mount(): HTMLElement {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        imports: [ChatComponent],
        providers: [{ provide: IPC_PORT, useValue: new FakeIpc() }],
      });
      const fixture: ComponentFixture<ChatComponent> = TestBed.createComponent(ChatComponent);
      const session = TestBed.inject(SessionService);
      session.addMessage({
        id: 'm1',
        role: 'user',
        text: 'Set a 10-minute pasta timer and track 200g spaghetti.',
        streaming: false,
      });
      session.addMessage({
        id: 'm2',
        role: 'assistant',
        text: 'Started a 10-minute timer and added {{q:200:g}} spaghetti to your list.',
        streaming: false,
      });
      session.lastTokPerSec.set(18.4);
      fixture.detectChanges();
      return fixture.nativeElement;
    }

    await expectNoSeriousOrCriticalViolations('chat', mount);
  });

  it('timer_stack: zero serious/critical violations (a running + a finished timer, both themes)', async () => {
    function mount(): HTMLElement {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        imports: [TimerStackComponent],
        providers: [{ provide: IPC_PORT, useValue: new FakeIpc() }],
      });
      const fixture: ComponentFixture<TimerStackComponent> = TestBed.createComponent(TimerStackComponent);
      const session = TestBed.inject(SessionService);
      session.upsertTimer({ timer_id: 't1', label: 'Pasta', duration_sec: 600, remaining_sec: 320, running: true });
      session.upsertTimer({ timer_id: 't2', label: 'Eggs', duration_sec: 300, remaining_sec: 0, running: false });
      fixture.detectChanges();
      return fixture.nativeElement;
    }

    await expectNoSeriousOrCriticalViolations('timer_stack', mount);
  });

  it('editable_list: zero serious/critical violations (a mixed-checked ingredient list, both themes)', async () => {
    function mount(): HTMLElement {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        imports: [EditableListComponent],
        providers: [{ provide: IPC_PORT, useValue: new FakeIpc() }],
      });
      const fixture: ComponentFixture<EditableListComponent> = TestBed.createComponent(EditableListComponent);
      const session = TestBed.inject(SessionService);
      session.setIngredients([
        { id: '1', name: 'Spaghetti', qty: 200, unit: 'g', checked: false },
        { id: '2', name: 'Eggs', qty: 2, checked: true },
        { id: '3', name: 'Pecorino', qty: 50, unit: 'g', checked: false },
      ]);
      fixture.detectChanges();
      return fixture.nativeElement;
    }

    await expectNoSeriousOrCriticalViolations('editable_list', mount);
  });

  it('segmented_toggle: zero serious/critical violations (default unit-system state, both themes)', async () => {
    function mount(): HTMLElement {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        imports: [SegmentedToggleComponent],
        providers: [{ provide: IPC_PORT, useValue: new FakeIpc() }],
      });
      const fixture: ComponentFixture<SegmentedToggleComponent> = TestBed.createComponent(SegmentedToggleComponent);
      fixture.detectChanges();
      return fixture.nativeElement;
    }

    await expectNoSeriousOrCriticalViolations('segmented_toggle', mount);
  });

  it('key_value_panel: zero serious/critical violations (self-sourced populated rows, both themes)', async () => {
    function mount(): HTMLElement {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({ imports: [KeyValuePanelComponent] });
      const fixture: ComponentFixture<KeyValuePanelComponent> = TestBed.createComponent(KeyValuePanelComponent);
      const component = fixture.componentInstance;
      component.title = 'Trip summary';
      component.fields = [
        { key: 'nights', label: 'Nights', value_type: 'integer' },
        { key: 'climate', label: 'Climate' },
      ];
      component.values = {
        nights: { raw: 5, present: true },
        climate: { raw: 'Warm', present: true },
      };
      fixture.detectChanges();
      return fixture.nativeElement;
    }

    await expectNoSeriousOrCriticalViolations('key_value_panel', mount);
  });

  it('date_time_picker: zero serious/critical violations (a committed date value, both themes)', async () => {
    function mount(): HTMLElement {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({ imports: [DateTimePickerComponent] });
      const fixture: ComponentFixture<DateTimePickerComponent> = TestBed.createComponent(DateTimePickerComponent);
      fixture.componentRef.setInput('mode', 'date');
      fixture.componentRef.setInput('title', 'Pickup date');
      fixture.componentRef.setInput('value', '2026-07-18');
      fixture.detectChanges();
      return fixture.nativeElement;
    }

    await expectNoSeriousOrCriticalViolations('date_time_picker', mount);
  });

  it('quick_actions: zero serious/critical violations (a mixed tone/icon action row, both themes)', async () => {
    function mount(): HTMLElement {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({ imports: [QuickActionsComponent] });
      const fixture: ComponentFixture<QuickActionsComponent> = TestBed.createComponent(QuickActionsComponent);
      fixture.componentRef.setInput('actions', [
        { id: 'add', label: 'Add ingredient', tool: 'list_manage', icon: 'plus' },
        { id: 'timer', label: 'Start timer', tool: 'start_timer', icon: 'timer', tone: 'accent' },
        { id: 'clear', label: 'Clear list', tool: 'list_manage', icon: 'trash', tone: 'danger', confirm: true },
      ]);
      fixture.componentRef.setInput('phase', 'ready');
      fixture.detectChanges();
      return fixture.nativeElement;
    }

    await expectNoSeriousOrCriticalViolations('quick_actions', mount);
  });

  it('progress: zero serious/critical violations (determinate, cancelable, mid-progress, both themes)', async () => {
    function mount(): HTMLElement {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({ imports: [ProgressComponent] });
      const fixture: ComponentFixture<ProgressComponent> = TestBed.createComponent(ProgressComponent);
      const component = fixture.componentInstance;
      component.title = 'Model download';
      component.mode = 'determinate';
      component.value = 0.45;
      component.cancelable = true;
      component.caption = 'Downloading the on-device model…';
      fixture.detectChanges();
      return fixture.nativeElement;
    }

    await expectNoSeriousOrCriticalViolations('progress', mount);
  });
});
