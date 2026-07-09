import { Injectable, Inject } from '@angular/core';
import {
  HardwareProfile,
  ListOp,
  SkillId,
  TELEMETRY_SCHEMA_VERSION,
  TelemetryEvent,
  ToolCallSource,
  UnitSystem,
} from '../ipc/contract';
import { IPC_PORT, IpcPort } from '../ipc/ipc.port';
import { SessionService } from './session.service';

/**
 * The one place the app emits telemetry events (P0-06.1). Every call
 * forwards to `telemetry_log` over the IPC port; Rust owns the actual
 * JSONL file (see IPC-CONTRACT.md — "telemetry sink" is a Rust
 * responsibility, never written directly by the webview).
 *
 * `MockIpcService` additionally buffers events in memory and exposes
 * `downloadLog()` (see mock-ipc.service.ts) so the JSONL schema can be
 * inspected without a real Tauri build — useful for building the P0-06.2
 * scoring sheet before the Rust side compiles anywhere.
 */
@Injectable({ providedIn: 'root' })
export class TelemetryService {
  constructor(@Inject(IPC_PORT) private readonly ipc: IpcPort, private readonly session: SessionService) {}

  private base() {
    return {
      schema_version: TELEMETRY_SCHEMA_VERSION,
      session_id: this.session.sessionId,
      ts_ms: Date.now(),
    };
  }

  private log(event: TelemetryEvent): void {
    void this.ipc.invoke('telemetry_log', event);
  }

  skillEnabled(skill_id: SkillId): void {
    this.log({ ...this.base(), event: 'skill_enabled', skill_id });
  }

  skillDisabled(skill_id: SkillId): void {
    this.log({ ...this.base(), event: 'skill_disabled', skill_id });
  }

  timerStarted(timer_id: string, label: string, duration_sec: number, source: ToolCallSource): void {
    this.log({ ...this.base(), event: 'timer_started', timer_id, label, duration_sec, source });
  }

  listEdited(op: ListOp, source: ToolCallSource, item_count_after: number): void {
    this.log({ ...this.base(), event: 'list_edited', op, source, item_count_after });
  }

  unitsFlipped(from: UnitSystem, to: UnitSystem, source: ToolCallSource): void {
    this.log({ ...this.base(), event: 'units_flipped', from, to, source });
  }

  tokPerSec(value: number, hardware: HardwareProfile): void {
    this.log({ ...this.base(), event: 'tok_per_sec', value, hardware });
  }

  outcome(name: 'timer_started_unprompted' | 'list_edited_unprompted' | 'session_end', detail?: string): void {
    this.log({ ...this.base(), event: 'outcome', name, detail });
  }
}
