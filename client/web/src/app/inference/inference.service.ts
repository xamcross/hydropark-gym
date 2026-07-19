import { Inject, Injectable, OnDestroy } from '@angular/core';
import { IPC_PORT, IpcPort, Unlisten } from '../ipc/ipc.port';
import { SessionService } from '../state/session.service';
import { TelemetryService } from '../state/telemetry.service';
import { ToolsService } from '../tools/tools.service';
import { ToolName } from '../ipc/contract';

/**
 * Maps a tool to the panel that should absorb a fallback prefill (SPEC §8.4
 * "fallback → widget mapping"). PARTIAL on purpose: the stateless catalog tools
 * (`calculate`, `date_math`) have no bound widget, so a malformed call to one of
 * them has no panel to prefill and degrades to the clarifying-question path.
 */
const TOOL_TO_WIDGET: Partial<Record<ToolName, string>> = {
  start_timer: 'timer_stack',
  convert_units: 'segmented_toggle',
  list_manage: 'editable_list',
};

/** `mm:ss`, matching `TimerStackComponent.formatRemaining`'s convention. */
function formatDuration(totalSec: number): string {
  const m = Math.floor(totalSec / 60)
    .toString()
    .padStart(2, '0');
  const s = Math.floor(totalSec % 60)
    .toString()
    .padStart(2, '0');
  return `${m}:${s}`;
}

/**
 * W02a — a tidy, human-readable one-line description of a validated tool
 * call, rendered as a system chat line in place of the raw wire JSON
 * (`{"name":"start_timer","arguments":{...}}`). Rust has ALREADY validated
 * and executed the call by the time `inference://tool_call_detected` fires
 * (see the event's doc comment in `contract.ts`) — this only describes it.
 * Defensive field reads (`args` is `Record<string, unknown>`, not a typed
 * `ToolArgsMap[T]`) so a shape surprise degrades to a generic phrase rather
 * than throwing.
 */
function describeToolCall(tool: ToolName, args: Record<string, unknown>): string {
  switch (tool) {
    case 'start_timer': {
      const label = typeof args['label'] === 'string' ? args['label'] : 'Timer';
      const duration = typeof args['duration_sec'] === 'number' ? ` — ${formatDuration(args['duration_sec'])}` : '';
      return `⏱ Setting a timer: "${label}"${duration}`;
    }
    case 'convert_units': {
      const value = args['value'];
      const from = args['from_unit'];
      const to = args['to_unit'];
      if (typeof value === 'number' && typeof from === 'string' && typeof to === 'string') {
        return `🔁 Converting ${value} ${from} to ${to}`;
      }
      return '🔁 Converting a unit';
    }
    case 'list_manage': {
      const op = args['op'];
      return typeof op === 'string' ? `📝 Updating the ingredient list (${op})` : '📝 Updating the ingredient list';
    }
    case 'calculate':
      return '🧮 Running a calculation';
    case 'date_math':
      return '📅 Working out a date';
    default:
      return '🔧 Running a tool';
  }
}

/**
 * Bridges streamed inference events (from the IPC port — real llama.cpp in
 * a real build, the scripted mock otherwise) into chat transcript state.
 * Also owns the P0-04.2 degrade behavior: on a malformed/invalid model
 * tool call, prefill the bound widget or ask exactly one clarifying
 * question — never a repair loop, never a silent failure.
 */
@Injectable({ providedIn: 'root' })
export class InferenceService implements OnDestroy {
  /** Widget prefill requests the UI can subscribe to (P0-04.2). */
  readonly prefillRequests = new Map<string, unknown>();
  private prefillListeners = new Set<(widget: string, args: unknown) => void>();

  private readonly unlisten: Unlisten[] = [];
  private currentMessageId: string | null = null;

  constructor(
    @Inject(IPC_PORT) private readonly ipc: IpcPort,
    private readonly session: SessionService,
    private readonly telemetry: TelemetryService,
    private readonly tools: ToolsService
  ) {
    this.unlisten.push(
      this.ipc.on('inference://token', (e) => {
        if (this.currentMessageId) this.session.appendToMessage(this.currentMessageId, e.token);
      }),
      // W02a — render a clean, tidy line for a validated tool call instead of
      // ever showing its raw wire JSON. `valid: false` (an invalid attempt
      // mid-repair) has no clean shape to render — the eventual
      // `tool_call_fallback` covers the user-facing UX for that case — and a
      // `tool` of `null` means the wire has no ToolName slot for it
      // (`calculate`/`date_math` — see `inference.rs`'s `ipc_tool`), so both
      // are skipped here rather than guessed at.
      this.ipc.on('inference://tool_call_detected', (e) => {
        if (!e.valid || !e.tool) return;
        this.session.addMessage({
          id: crypto.randomUUID(),
          role: 'system',
          text: describeToolCall(e.tool, e.parsed_args ?? {}),
          streaming: false,
        });
      }),
      this.ipc.on('inference://tool_call_result', (e) => {
        this.tools.applyResult(e.tool, e.result, 'model');
      }),
      this.ipc.on('inference://tool_call_fallback', (e) => {
        const widget = e.tool ? TOOL_TO_WIDGET[e.tool] : undefined;
        if (widget) {
          this.notifyPrefill(widget, e.parsed_args ?? {});
          this.session.addMessage({
            id: crypto.randomUUID(),
            role: 'system',
            text: `I wasn't sure I got that right, so I've prefilled the ${widget.replace('_', ' ')} panel — please confirm.`,
            streaming: false,
          });
        } else if (e.clarifying_question) {
          this.session.addMessage({
            id: crypto.randomUUID(),
            role: 'assistant',
            text: e.clarifying_question,
            streaming: false,
          });
        }
      }),
      this.ipc.on('inference://done', (e) => {
        if (this.currentMessageId) this.session.finishMessageStream(this.currentMessageId);
        this.currentMessageId = null;
        this.session.lastTokPerSec.set(e.tok_per_sec);
        const hw = this.session.hardwareProfile();
        if (hw) this.telemetry.tokPerSec(e.tok_per_sec, hw);
      }),
      this.ipc.on('inference://error', (e) => {
        if (this.currentMessageId) {
          this.session.appendToMessage(this.currentMessageId, `\n[error: ${e.message}]`);
          this.session.finishMessageStream(this.currentMessageId);
        }
        this.currentMessageId = null;
      })
    );
  }

  onPrefillRequest(handler: (widget: string, args: unknown) => void): Unlisten {
    this.prefillListeners.add(handler);
    return () => this.prefillListeners.delete(handler);
  }

  private notifyPrefill(widget: string, args: unknown): void {
    this.prefillListeners.forEach((h) => h(widget, args));
  }

  async send(userMessage: string): Promise<void> {
    this.session.addMessage({ id: crypto.randomUUID(), role: 'user', text: userMessage, streaming: false });
    const replyId = crypto.randomUUID();
    this.currentMessageId = replyId;
    this.session.addMessage({ id: replyId, role: 'assistant', text: '', streaming: true });
    await this.ipc.invoke('inference_start', {
      session_id: this.session.sessionId,
      user_message: userMessage,
      skill_id: this.session.activeSkillId() ?? undefined,
    });
  }

  cancel(): void {
    void this.ipc.invoke('inference_cancel', { session_id: this.session.sessionId });
  }

  ngOnDestroy(): void {
    this.unlisten.forEach((fn) => fn());
  }
}
