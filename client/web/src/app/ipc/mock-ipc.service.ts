import { Injectable } from '@angular/core';
import {
  HardwareProfile,
  IngredientItem,
  IpcCommand,
  IpcCommandMap,
  IpcEvent,
  IpcEventMap,
  ListManageArgs,
  ListManageResult,
  StartTimerArgs,
  TelemetryEvent,
  TimerStateSnapshot,
  ToolCallRequest,
  ToolCallResponse,
  ToolName,
} from './contract';
import { IpcPort, Unlisten } from './ipc.port';
import { convertUnitsExact, UnitConversionError } from '../tools/unit-math';
import { validateToolCall } from '../tools/tool-validation';

interface MockTimer {
  timer_id: string;
  label: string;
  duration_sec: number;
  remaining_sec: number;
  running: boolean;
  interval: ReturnType<typeof setInterval> | null;
}

/** One scripted "turn" of the mock inference brain — see `scriptTurn()` below. */
type ScriptStep =
  | { kind: 'text'; text: string }
  | { kind: 'tool_call_valid'; tool: ToolName; args: Record<string, unknown> }
  | { kind: 'tool_call_malformed'; raw: string };

/**
 * In-browser stand-in for the Rust core. Implements the exact same
 * `IpcPort` contract `TauriIpcService` does, so every Angular component
 * is written once and works against either. This is what makes
 * `ng serve` / `ng build` succeed with no llama.cpp, no GGUF, and no
 * compiled Rust anywhere (see client/README.md).
 *
 * Responsibilities simulated here (normally Rust's, per IPC-CONTRACT.md):
 *  - tool execution (start_timer / convert_units / list_manage)
 *  - timer countdown ticking (setInterval instead of a Tokio task)
 *  - a scripted token-stream "model" that occasionally emits a
 *    `<tool_call>` — including a deliberately malformed one, to exercise
 *    the P0-04.2 fallback path end-to-end without a real model
 *  - a JSONL telemetry sink (kept in memory + downloadable; a real file
 *    write is a Rust/filesystem responsibility)
 */
@Injectable()
export class MockIpcService extends IpcPort {
  private readonly listeners = new Map<IpcEvent, Set<(payload: unknown) => void>>();
  private readonly timers = new Map<string, MockTimer>();
  private ingredients: IngredientItem[] = [];
  private readonly cancelledSessions = new Set<string>();
  private readonly telemetryLog: TelemetryEvent[] = [];
  private itemSeq = 0;

  // ---- IpcPort ------------------------------------------------------------

  async invoke<K extends IpcCommand>(cmd: K, args: IpcCommandMap[K]['args']): Promise<IpcCommandMap[K]['result']> {
    switch (cmd) {
      case 'tool_call':
        return this.handleToolCall(args as ToolCallRequest) as IpcCommandMap[K]['result'];
      case 'inference_start':
        this.runInference(args as IpcCommandMap['inference_start']['args']);
        return undefined as IpcCommandMap[K]['result'];
      case 'inference_cancel':
        this.cancelledSessions.add((args as IpcCommandMap['inference_cancel']['args']).session_id);
        return undefined as IpcCommandMap[K]['result'];
      case 'skill_enable':
        return this.handleSkillEnable(args as IpcCommandMap['skill_enable']['args']) as IpcCommandMap[K]['result'];
      case 'skill_disable':
        return undefined as IpcCommandMap[K]['result'];
      case 'timer_pause':
        return this.setTimerRunning((args as { timer_id: string }).timer_id, false) as IpcCommandMap[K]['result'];
      case 'timer_resume':
        return this.setTimerRunning((args as { timer_id: string }).timer_id, true) as IpcCommandMap[K]['result'];
      case 'timer_reset':
        return this.resetTimer((args as { timer_id: string }).timer_id) as IpcCommandMap[K]['result'];
      case 'get_hardware_profile':
        return this.readHardwareProfile() as IpcCommandMap[K]['result'];
      case 'telemetry_log':
        this.telemetryLog.push(args as TelemetryEvent);
        // eslint-disable-next-line no-console
        console.debug('[telemetry]', JSON.stringify(args));
        return undefined as IpcCommandMap[K]['result'];
      case 'notify':
        this.showNotification(args as IpcCommandMap['notify']['args']);
        return undefined as IpcCommandMap[K]['result'];
      default:
        throw new Error(`MockIpcService: unhandled command "${String(cmd)}"`);
    }
  }

  on<K extends IpcEvent>(event: K, handler: (payload: IpcEventMap[K]) => void): Unlisten {
    const set = this.listeners.get(event) ?? new Set();
    set.add(handler as (payload: unknown) => void);
    this.listeners.set(event, set);
    return () => set.delete(handler as (payload: unknown) => void);
  }

  private emit<K extends IpcEvent>(event: K, payload: IpcEventMap[K]): void {
    this.listeners.get(event)?.forEach((h) => h(payload));
  }

  /** Dev convenience: the JSONL a real build would have written to disk (P0-06.1). Not part of IpcPort — wired to a debug button in app.component. */
  downloadTelemetryLog(): void {
    const jsonl = this.telemetryLog.map((e) => JSON.stringify(e)).join('\n') + '\n';
    const blob = new Blob([jsonl], { type: 'application/x-ndjson' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hydropark-session-${Date.now()}.jsonl`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---- tool execution -------------------------------------------------------

  private handleToolCall(req: ToolCallRequest): ToolCallResponse {
    const validated = validateToolCall(req.tool, req.args);
    if (!validated.ok) {
      return {
        request_id: req.request_id,
        ok: false,
        tool: validated.tool,
        error: { code: validated.reason, message: validated.message },
      };
    }
    try {
      switch (validated.tool) {
        case 'start_timer':
          return {
            request_id: req.request_id,
            ok: true,
            tool: 'start_timer',
            result: this.startTimer(validated.args as StartTimerArgs),
          };
        case 'convert_units':
          return {
            request_id: req.request_id,
            ok: true,
            tool: 'convert_units',
            result: convertUnitsExact(validated.args as never),
          };
        case 'list_manage':
          return {
            request_id: req.request_id,
            ok: true,
            tool: 'list_manage',
            result: this.listManage(validated.args as ListManageArgs),
          };
      }
    } catch (e) {
      const message = e instanceof UnitConversionError ? e.message : String(e);
      return { request_id: req.request_id, ok: false, tool: req.tool, error: { code: 'execution_error', message } };
    }
  }

  private startTimer(args: StartTimerArgs): { timer_id: string; label: string; duration_sec: number; started_at_ms: number } {
    const timer_id = crypto.randomUUID();
    const t: MockTimer = {
      timer_id,
      label: args.label,
      duration_sec: args.duration_sec,
      remaining_sec: args.duration_sec,
      running: true,
      interval: null,
    };
    this.timers.set(timer_id, t);
    this.armInterval(t);
    return { timer_id, label: t.label, duration_sec: t.duration_sec, started_at_ms: Date.now() };
  }

  private armInterval(t: MockTimer): void {
    if (t.interval) clearInterval(t.interval);
    t.interval = setInterval(() => {
      if (!t.running) return;
      t.remaining_sec = Math.max(0, t.remaining_sec - 1);
      this.emit('timer://tick', { timer_id: t.timer_id, remaining_sec: t.remaining_sec });
      if (t.remaining_sec === 0) {
        t.running = false;
        clearInterval(t.interval!);
        t.interval = null;
        this.emit('timer://finished', { timer_id: t.timer_id, label: t.label });
      }
    }, 1000);
  }

  private setTimerRunning(timer_id: string, running: boolean): TimerStateSnapshot {
    const t = this.timers.get(timer_id);
    if (!t) throw new Error(`unknown timer ${timer_id}`);
    t.running = running && t.remaining_sec > 0;
    if (t.running) this.armInterval(t);
    else if (t.interval) {
      clearInterval(t.interval);
      t.interval = null;
    }
    const snap = this.snapshotTimer(t);
    this.emit('timer://updated', snap);
    return snap;
  }

  private resetTimer(timer_id: string): TimerStateSnapshot {
    const t = this.timers.get(timer_id);
    if (!t) throw new Error(`unknown timer ${timer_id}`);
    t.remaining_sec = t.duration_sec;
    t.running = false;
    if (t.interval) {
      clearInterval(t.interval);
      t.interval = null;
    }
    const snap = this.snapshotTimer(t);
    this.emit('timer://updated', snap);
    return snap;
  }

  private snapshotTimer(t: MockTimer): TimerStateSnapshot {
    return { timer_id: t.timer_id, label: t.label, duration_sec: t.duration_sec, remaining_sec: t.remaining_sec, running: t.running };
  }

  private nextItemId(): string {
    this.itemSeq += 1;
    return `item_${this.itemSeq}`;
  }

  private listManage(args: ListManageArgs): ListManageResult {
    switch (args.op) {
      case 'add': {
        const item: IngredientItem = {
          id: this.nextItemId(),
          name: args.item!.name!,
          qty: args.item?.qty,
          unit: args.item?.unit,
          checked: false,
        };
        this.ingredients = [...this.ingredients, item];
        break;
      }
      case 'remove':
        this.ingredients = this.ingredients.filter((i) => i.id !== args.item!.id);
        break;
      case 'check':
        this.ingredients = this.ingredients.map((i) => (i.id === args.item!.id ? { ...i, checked: true } : i));
        break;
      case 'uncheck':
        this.ingredients = this.ingredients.map((i) => (i.id === args.item!.id ? { ...i, checked: false } : i));
        break;
      case 'set_all':
        this.ingredients = (args.items ?? []).map((i) => ({ ...i, id: i.id ?? this.nextItemId() }));
        break;
    }
    return { ingredients: this.ingredients };
  }

  // ---- skill lifecycle --------------------------------------------------

  private handleSkillEnable(args: IpcCommandMap['skill_enable']['args']): IpcCommandMap['skill_enable']['result'] {
    return {
      skill_id: args.skill_id,
      persona_injected: true,
      tools_registered: ['start_timer', 'convert_units', 'list_manage'],
      panels: ['timer_stack', 'editable_list', 'segmented_toggle'],
    };
  }

  // ---- hardware profiling (P0-02.3, read-only) ---------------------------

  private readHardwareProfile(): HardwareProfile {
    const nav = navigator as Navigator & { deviceMemory?: number };
    let gpu_present = false;
    try {
      const canvas = document.createElement('canvas');
      gpu_present = !!(canvas.getContext('webgl2') || canvas.getContext('webgl'));
    } catch {
      gpu_present = false;
    }
    return {
      ram_gb: nav.deviceMemory ?? 8,
      cores: navigator.hardwareConcurrency ?? 4,
      gpu_present,
    };
  }

  // ---- notifications (P0-05.4) -------------------------------------------

  private showNotification(args: IpcCommandMap['notify']['args']): void {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'granted') {
      new Notification(args.title, { body: args.body });
      return;
    }
    if (Notification.permission !== 'denied') {
      Notification.requestPermission().then((perm) => {
        if (perm === 'granted') new Notification(args.title, { body: args.body });
      });
    }
    // If denied: silently no-op here. The in-app fallback (a system chat
    // line + toast) is rendered unconditionally by timer-stack.component on
    // `timer://finished`, independent of OS notification permission — see
    // SPEC §9.7 "degrades to an in-app alert if denied".
  }

  // ---- mock inference (interface behind which a real llama.cpp stream
  //      would sit — see client/src-tauri/src/inference.rs) -----------------

  private async runInference(args: IpcCommandMap['inference_start']['args']): Promise<void> {
    const { session_id, user_message, skill_id } = args;
    this.cancelledSessions.delete(session_id);
    const steps = this.scriptTurn(user_message, skill_id === 'kitchen-timer');
    const start = performance.now();
    let seq = 0;
    let tokenCount = 0;

    for (const step of steps) {
      if (this.cancelledSessions.has(session_id)) break;

      if (step.kind === 'text') {
        const words = step.text.split(/(\s+)/).filter((w) => w.length > 0);
        for (const w of words) {
          if (this.cancelledSessions.has(session_id)) break;
          await sleep(18 + Math.random() * 24);
          tokenCount += 1;
          this.emit('inference://token', { session_id, seq: seq++, token: w });
        }
      } else if (step.kind === 'tool_call_valid') {
        await sleep(120);
        this.emit('inference://tool_call_detected', {
          session_id,
          raw: `<tool_call>${JSON.stringify({ name: step.tool, arguments: step.args })}</tool_call>`,
          tool: step.tool,
          parsed_args: step.args,
          valid: true,
        });
        const resp = this.handleToolCall({ request_id: crypto.randomUUID(), tool: step.tool, args: step.args as never, source: 'model' });
        if (resp.ok) {
          this.emit('inference://tool_call_result', { session_id, tool: resp.tool, result: resp.result });
        }
      } else if (step.kind === 'tool_call_malformed') {
        await sleep(120);
        const parsed = tryParseToolCall(step.raw);
        const validated = parsed ? validateToolCall(parsed.name, parsed.arguments) : null;
        this.emit('inference://tool_call_detected', {
          session_id,
          raw: step.raw,
          tool: validated?.tool ?? (parsed?.name as ToolName) ?? null,
          parsed_args: (parsed?.arguments as Record<string, unknown>) ?? null,
          valid: false,
        });
        this.emit('inference://tool_call_fallback', {
          session_id,
          reason: !parsed ? 'malformed_json' : validated && !validated.ok ? validated.reason : 'invalid_args',
          tool: (validated?.tool ?? null) as ToolName | null,
          parsed_args: (parsed?.arguments as Record<string, unknown>) ?? null,
          clarifying_question:
            parsed?.name && ['start_timer', 'convert_units', 'list_manage'].includes(parsed.name)
              ? null
              : 'Could you tell me what you would like me to do — start a timer, update the ingredient list, or convert a unit?',
        });
      }
    }

    const elapsed_ms = performance.now() - start;
    const tok_per_sec = tokenCount > 0 ? Math.round((tokenCount / (elapsed_ms / 1000)) * 10) / 10 : 0;
    this.emit('inference://done', { session_id, tokens_generated: tokenCount, elapsed_ms, tok_per_sec });
  }

  /** The scripted "brain" — see file header. Real inference.rs replaces this whole method. */
  private scriptTurn(userMessage: string, skillEnabled: boolean): ScriptStep[] {
    const msg = userMessage.toLowerCase();

    if (!skillEnabled) {
      return [
        {
          kind: 'text',
          text:
            "I'm the base Hydropark agent — I can chat, but I don't have cooking tools yet. " +
            'Enable "Kitchen Timer & Units" above and ask me again — I\'ll be able to start timers, ' +
            'build an ingredient list, and convert units for you.',
        },
      ];
    }

    if (msg.includes('confuse') || msg.includes('gibberish')) {
      return [
        { kind: 'text', text: "Hmm, let me think about how to help with that." },
        { kind: 'tool_call_malformed', raw: '<tool_call>{not valid json at all' },
      ];
    }

    if (msg.includes('unknown tool') || msg.includes('random tool')) {
      return [
        { kind: 'text', text: 'One moment —' },
        {
          kind: 'tool_call_malformed',
          raw: '<tool_call>{"name":"delete_everything","arguments":{}}</tool_call>',
        },
      ];
    }

    if (msg.includes('surprise')) {
      return [
        { kind: 'text', text: 'Sure, let me set that up for you —' },
        { kind: 'tool_call_malformed', raw: '<tool_call>{"name":"start_timer","arguments":{"label":"Mystery"}}</tool_call>' },
        { kind: 'text', text: "I've prefilled a timer below — just tell me how long to set it for." },
      ];
    }

    if (msg.includes('carbonara')) {
      return [
        { kind: 'text', text: "Great choice! Let's cook carbonara for 4. Here's what you'll need —" },
        {
          kind: 'tool_call_valid',
          tool: 'list_manage',
          args: {
            op: 'set_all',
            items: [
              { name: 'Spaghetti', qty: 400, unit: 'g', checked: false },
              { name: 'Guanciale (or pancetta)', qty: 150, unit: 'g', checked: false },
              { name: 'Egg yolks', qty: 4, checked: false },
              { name: 'Whole egg', qty: 1, checked: false },
              { name: 'Pecorino Romano, grated', qty: 50, unit: 'g', checked: false },
              { name: 'Black pepper', checked: false },
            ],
          },
        },
        {
          kind: 'text',
          text:
            "I've filled in the ingredient list — flip to Metric or US anytime, it re-converts everything " +
            'exactly (e.g. {{q:150:g}} of guanciale, {{q:50:g}} of pecorino). Starting the pasta timer now —',
        },
        { kind: 'tool_call_valid', tool: 'start_timer', args: { label: 'Pasta', duration_sec: 9 * 60 } },
        {
          kind: 'text',
          text: "Pasta timer is running (9:00). I'll ping you when it's done — want a sauce timer too?",
        },
      ];
    }

    return [
      {
        kind: 'text',
        text:
          'Kitchen Timer & Units is on — try "Help me cook carbonara for 4" to see the full flow, or ' +
          'tap "+ timer", edit the list, or flip US/Metric yourself any time.',
      },
    ];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tryParseToolCall(raw: string): { name: string; arguments: unknown } | null {
  const match = raw.match(/<tool_call>([\s\S]*?)<\/tool_call>/);
  const jsonText = match ? match[1] : raw;
  try {
    const parsed = JSON.parse(jsonText);
    if (typeof parsed === 'object' && parsed && 'name' in parsed) {
      return parsed as { name: string; arguments: unknown };
    }
    return null;
  } catch {
    return null;
  }
}
