import { ElementRef, Inject, Injectable, computed, signal } from '@angular/core';
import { IPC_PORT, IpcPort, Unlisten } from '../ipc/ipc.port';
import { SessionService } from '../state/session.service';
import { TelemetryService } from '../state/telemetry.service';
import { SkillId } from '../ipc/contract';
import { MAGIC_PROMPT, TOUR_STEPS, TourAnchorId, TourChatBridge, TourStep } from './tour.model';

const SEEN_KEY = 'hydropark.tour.completed.v1';
const FREE_SKILL_ID: SkillId = 'kitchen-timer';
/** How long to wait on the model before showing a "still working" hint (magic beat). */
const MAGIC_SLOW_MS = 20_000;

type FinishAction = 'complete' | 'skip';

/**
 * TOUR SERVICE — owns the first-run spotlight tour's state and lifecycle
 * (no DOM). Auto-runs once (a resettable localStorage flag), tracks the active
 * step, self-skips steps whose anchor isn't on screen, and (Task 4) drives the
 * one hands-on "magic beat" through a registered chat bridge.
 */
@Injectable({ providedIn: 'root' })
export class TourService {
  readonly steps = TOUR_STEPS;

  private readonly _active = signal(false);
  readonly active = this._active.asReadonly();

  private readonly _index = signal(0);
  readonly index = this._index.asReadonly();
  readonly step = computed<TourStep>(() => TOUR_STEPS[this._index()]);
  readonly stepNumber = computed(() => this._index() + 1);

  // Reactive anchor registry so the overlay repositions when anchors mount/unmount.
  private readonly _anchors = signal<ReadonlyMap<TourAnchorId, HTMLElement>>(new Map());
  readonly currentAnchor = computed<HTMLElement | null>(() => {
    const el = this._anchors().get(this.step().id);
    return el && el.isConnected ? el : null;
  });
  readonly isLast = computed(() => this.nextResolvable(this._index() + 1) === null);

  // Magic-beat state (wired in Task 4).
  private readonly _suggestedPrompt = signal<string | null>(null);
  readonly suggestedPrompt = this._suggestedPrompt.asReadonly();
  private readonly _awaitingMagic = signal(false);
  readonly awaitingMagic = this._awaitingMagic.asReadonly();
  private readonly _magicSlow = signal(false);
  readonly magicSlow = this._magicSlow.asReadonly();
  private chat: TourChatBridge | null = null;
  private magicUnlisten: Unlisten | null = null;
  private magicTimer: ReturnType<typeof setTimeout> | null = null;
  private magicBaseline = 0;

  constructor(
    @Inject(IPC_PORT) private readonly ipc: IpcPort,
    private readonly session: SessionService,
    private readonly telemetry: TelemetryService
  ) {}

  // --- anchor registry -----------------------------------------------------

  registerAnchor(id: TourAnchorId, el: ElementRef<HTMLElement>): void {
    const next = new Map(this._anchors());
    next.set(id, el.nativeElement);
    this._anchors.set(next);
  }
  unregisterAnchor(id: TourAnchorId, el: ElementRef<HTMLElement>): void {
    if (this._anchors().get(id) !== el.nativeElement) return;
    const next = new Map(this._anchors());
    next.delete(id);
    this._anchors.set(next);
  }
  resolve(id: TourAnchorId): HTMLElement | null {
    const el = this._anchors().get(id);
    return el && el.isConnected ? el : null;
  }

  // --- chat bridge (Task 4 uses these) -------------------------------------

  registerChat(bridge: TourChatBridge): void {
    this.chat = bridge;
    const p = this._suggestedPrompt();
    if (p) bridge.prefill(p);
  }
  unregisterChat(bridge: TourChatBridge): void {
    if (this.chat === bridge) this.chat = null;
  }

  // --- lifecycle -----------------------------------------------------------

  start(force = false): void {
    if (this._active()) return;
    if (!force && this.hasSeen()) return;
    const first = this.nextResolvable(0);
    if (first === null) return;
    this._index.set(first);
    this._active.set(true);
    this.telemetry.tour('start', first + 1);
    this.syncStep();
  }

  next(): void {
    this.clearMagicWait();
    const n = this.nextResolvable(this._index() + 1);
    if (n === null) { this.complete(); return; }
    this._index.set(n);
    this.telemetry.tour('advance', n + 1);
    this.syncStep();
  }

  back(): void {
    this.clearMagicWait();
    const p = this.prevResolvable(this._index() - 1);
    if (p === null) return;
    this._index.set(p);
    this.syncStep();
  }

  complete(): void { this.finish('complete'); }
  skip(): void { this.finish('skip'); }

  private finish(action: FinishAction): void {
    this.clearMagicWait();
    if (this._active()) this.telemetry.tour(action, this._index() + 1);
    this.write(SEEN_KEY, '1');
    this._active.set(false);
    this._suggestedPrompt.set(null);
  }

  // --- step sync (arm the magic prompt on the magic step) ------------------

  private syncStep(): void {
    const s = TOUR_STEPS[this._index()];
    if (s.advance === 'magic') {
      this._suggestedPrompt.set(MAGIC_PROMPT);
      this.chat?.prefill(MAGIC_PROMPT);
    } else {
      this._suggestedPrompt.set(null);
    }
  }

  // --- magic beat (fully implemented in Task 4) ----------------------------

  async fireSuggestedSend(): Promise<void> {
    // Implemented in Task 4.
  }
  private clearMagicWait(): void {
    if (this.magicUnlisten) { this.magicUnlisten(); this.magicUnlisten = null; }
    if (this.magicTimer) { clearTimeout(this.magicTimer); this.magicTimer = null; }
    this._awaitingMagic.set(false);
    this._magicSlow.set(false);
  }

  // --- resolvable-step helpers --------------------------------------------

  private nextResolvable(from: number): number | null {
    for (let i = from; i < TOUR_STEPS.length; i++) {
      if (this.resolve(TOUR_STEPS[i].id)) return i;
    }
    return null;
  }
  private prevResolvable(from: number): number | null {
    for (let i = from; i >= 0; i--) {
      if (this.resolve(TOUR_STEPS[i].id)) return i;
    }
    return null;
  }

  // --- durable flag (guarded) ---------------------------------------------

  private hasSeen(): boolean { return this.read(SEEN_KEY) === '1'; }
  private read(key: string): string | null {
    try { return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null; } catch { return null; }
  }
  private write(key: string, value: string): void {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(key, value); } catch { /* ignore */ }
  }
}
