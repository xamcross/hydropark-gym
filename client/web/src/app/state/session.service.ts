import { Injectable, computed, signal } from '@angular/core';
import { HardwareProfile, IngredientItem, SkillId, TimerStateSnapshot, UnitSystem } from '../ipc/contract';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  /** Raw text, possibly containing inline `{{q:VALUE:UNIT}}` quantity tokens — see chat.component.ts. */
  text: string;
  streaming: boolean;
}

export interface TimerViewState extends TimerStateSnapshot {}

/**
 * Single in-memory session store, the Angular-side half of "state lives in
 * memory + a JSONL log file, no DB" (PHASE0-PLAN §3.1). Everything here is
 * session-scoped and disposable — Phase 0 is explicitly throwaway
 * (PHASE0-PLAN §0).
 *
 * Rust remains the source of truth for anything it owns (timer countdown,
 * inference, tool execution — see IPC-CONTRACT.md); this service mirrors
 * the parts of that state the UI needs to render, updated by IPC events.
 */
@Injectable({ providedIn: 'root' })
export class SessionService {
  readonly sessionId = crypto.randomUUID();

  readonly messages = signal<ChatMessage[]>([]);
  readonly ingredients = signal<IngredientItem[]>([]);
  readonly timers = signal<Record<string, TimerViewState>>({});
  readonly unitSystem = signal<UnitSystem>('US');

  readonly kitchenSkillEnabled = signal(false);
  readonly hardwareProfile = signal<HardwareProfile | null>(null);
  readonly lastTokPerSec = signal<number | null>(null);

  readonly activeSkillId = computed<SkillId | null>(() =>
    this.kitchenSkillEnabled() ? 'kitchen-timer-units' : null
  );

  readonly timerList = computed(() =>
    Object.values(this.timers()).sort((a, b) => a.label.localeCompare(b.label))
  );

  addMessage(msg: ChatMessage): void {
    this.messages.update((list) => [...list, msg]);
  }

  appendToMessage(id: string, chunk: string): void {
    this.messages.update((list) =>
      list.map((m) => (m.id === id ? { ...m, text: m.text + chunk } : m))
    );
  }

  finishMessageStream(id: string): void {
    this.messages.update((list) =>
      list.map((m) => (m.id === id ? { ...m, streaming: false } : m))
    );
  }

  setIngredients(items: IngredientItem[]): void {
    this.ingredients.set(items);
  }

  upsertTimer(t: TimerViewState): void {
    this.timers.update((map) => ({ ...map, [t.timer_id]: t }));
  }

  patchTimerRemaining(timer_id: string, remaining_sec: number): void {
    this.timers.update((map) => {
      const existing = map[timer_id];
      if (!existing) return map;
      return { ...map, [timer_id]: { ...existing, remaining_sec } };
    });
  }
}
