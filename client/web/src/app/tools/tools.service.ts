import { Inject, Injectable } from '@angular/core';
import {
  ConvertUnitsArgs,
  ConvertUnitsResult,
  ListManageArgs,
  ListManageResult,
  StartTimerArgs,
  StartTimerResult,
  ToolArgsMap,
  ToolCallSource,
  ToolName,
  ToolResultMap,
} from '../ipc/contract';
import { IPC_PORT, IpcPort } from '../ipc/ipc.port';
import { SessionService } from '../state/session.service';
import { TelemetryService } from '../state/telemetry.service';

/**
 * The single place tool results are turned into UI state + telemetry,
 * regardless of whether the call came from the UI-first path (P0-03.6,
 * `source: 'ui'`) or was executed by the model path and merely reported
 * back for rendering (P0-04.1, `source: 'model'`). This is what keeps
 * "tap the + timer button" and "the model calls start_timer" behave
 * identically once the result lands — see IPC-CONTRACT.md.
 */
@Injectable({ providedIn: 'root' })
export class ToolsService {
  constructor(
    @Inject(IPC_PORT) private readonly ipc: IpcPort,
    private readonly session: SessionService,
    private readonly telemetry: TelemetryService
  ) {}

  // --- UI-first triggers (P0-03.6): no model round-trip, ever ------------

  startTimer(args: StartTimerArgs): Promise<StartTimerResult | null> {
    return this.dispatch('start_timer', args);
  }

  convertUnits(args: ConvertUnitsArgs): Promise<ConvertUnitsResult | null> {
    return this.dispatch('convert_units', args);
  }

  listManage(args: ListManageArgs): Promise<ListManageResult | null> {
    return this.dispatch('list_manage', args);
  }

  async pauseTimer(timer_id: string) {
    const snap = await this.ipc.invoke('timer_pause', { timer_id });
    this.session.upsertTimer(snap);
    return snap;
  }

  async resumeTimer(timer_id: string) {
    const snap = await this.ipc.invoke('timer_resume', { timer_id });
    this.session.upsertTimer(snap);
    return snap;
  }

  async resetTimer(timer_id: string) {
    const snap = await this.ipc.invoke('timer_reset', { timer_id });
    this.session.upsertTimer(snap);
    return snap;
  }

  /** Dispatches a UI-first tool call: builds the request, invokes, applies the result. Never touched by the model path. */
  private async dispatch<T extends ToolName>(tool: T, args: ToolArgsMap[T]): Promise<ToolResultMap[T] | null> {
    const request_id = crypto.randomUUID();
    const resp = await this.ipc.invoke('tool_call', { request_id, tool, args, source: 'ui' });
    if (!resp.ok) {
      console.warn(`[tools] ${tool} failed: ${resp.error.message}`);
      return null;
    }
    const result = resp.result as ToolResultMap[T];
    const op = tool === 'list_manage' ? (args as ListManageArgs).op : undefined;
    this.applyResult(tool, result, 'ui', op);
    return result;
  }

  /**
   * Applies an already-executed tool result to UI state + telemetry. Called
   * by `dispatch` above (UI-first path) and by the inference event handler
   * for model-sourced calls that Rust already validated and ran.
   */
  applyResult<T extends ToolName>(tool: T, result: ToolResultMap[T], source: ToolCallSource, op?: ListManageArgs['op']): void {
    switch (tool) {
      case 'start_timer': {
        const r = result as StartTimerResult;
        this.session.upsertTimer({
          timer_id: r.timer_id,
          label: r.label,
          duration_sec: r.duration_sec,
          remaining_sec: r.duration_sec,
          running: true,
        });
        this.telemetry.timerStarted(r.timer_id, r.label, r.duration_sec, source);
        this.telemetry.outcome('timer_started_unprompted', source === 'ui' ? 'ui-trigger' : 'model-trigger');
        break;
      }
      case 'list_manage': {
        const r = result as ListManageResult;
        this.session.setIngredients(r.ingredients);
        this.telemetry.listEdited(op ?? 'add', source, r.ingredients.length);
        this.telemetry.outcome('list_edited_unprompted', source === 'ui' ? 'ui-trigger' : 'model-trigger');
        break;
      }
      case 'convert_units':
        // convert_units results are consumed directly by the caller (segmented_toggle,
        // chat quantity re-render) — no shared session state to update here.
        break;
    }
  }
}
