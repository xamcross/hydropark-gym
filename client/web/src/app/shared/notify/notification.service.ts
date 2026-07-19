import { DestroyRef, Injectable, Signal, inject, signal } from '@angular/core';
import { IPC_PORT } from '../../ipc/ipc.port';
import { isTauriRuntime } from '../../ipc/tauri-ipc.service';
import { motionMs } from '../motion';
import { NotifyOptions, NotifyOutcome, Toast, ToastSeverity } from './notification.model';

const DEFAULT_TIMEOUT_MS = 6000;
/** Kept in step with the toast's exit transition (toast-host.component.css). */
const TOAST_EXIT_MS = 200;

/**
 * P1-06.7 — notifications & alerts for time-critical widget events (SPEC §9.7:
 * a finished timer must reach the user even when the panel is collapsed, the
 * window is backgrounded, or another tab is showing).
 *
 * Delivery ladder (first one that works wins):
 *   1. **Tauri** — when hosted in the Tauri webview, delegate to the P0's OS
 *      notification command exposed over the IPC seam (`notify` in
 *      ipc/contract.ts → src-tauri owns the real OS notification + sound). This
 *      is the correct surface inside the shell (the webview's own Notification
 *      API is unreliable there).
 *   2. **Web Notification API** — a plain browser (or a webview without the
 *      plugin). Permission is requested on first use; on grant we post an OS
 *      notification + a short chime.
 *   3. **In-app toast** — when notifications are denied or unavailable, degrade
 *      to a `role="alert"` toast (+ best-effort chime). Rendered by
 *      `ToastHostComponent`, which reads the `toasts` signal below.
 *
 * The permission prompt fires lazily ("during the first skill that needs it",
 * §9.7) — i.e. on the first `notify()` — never at app boot.
 *
 * Reuse: any flow that currently calls `ipc.invoke('notify', …)` directly (e.g.
 * timer-sync.service on `timer://finished`) can route through `notify()` here
 * instead to gain the permission handling, the chime, and the guaranteed in-app
 * fallback in one call.
 */
@Injectable({ providedIn: 'root' })
export class NotificationService {
  private readonly ipc = inject(IPC_PORT, { optional: true });

  private readonly _toasts = signal<readonly Toast[]>([]);
  /** The live in-app toast stack — bind a `ToastHostComponent` to this. */
  readonly toasts: Signal<readonly Toast[]> = this._toasts.asReadonly();

  /** id → pending timer (auto-dismiss or exit-removal). */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private permissionRequest: Promise<NotificationPermission> | null = null;
  private audioCtx: AudioContext | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.teardown());
  }

  /**
   * Fire a time-critical alert down the delivery ladder above.
   * Resolves with which surface handled it (useful for telemetry/tests).
   */
  async notify(opts: NotifyOptions): Promise<NotifyOutcome> {
    const sound = opts.sound ?? true;

    // 1) Tauri shell — hand off to the Rust-owned OS notification command.
    if (isTauriRuntime() && this.ipc) {
      try {
        await this.ipc.invoke('notify', { title: opts.title, body: opts.body, sound });
        return { channel: 'os-tauri', sounded: sound, permission: 'tauri' };
      } catch {
        // Command not registered yet / bridge error — fall through to web + in-app.
      }
    }

    // 2) Web Notification API.
    if (typeof Notification !== 'undefined') {
      const permission = await this.ensureWebPermission();
      if (permission === 'granted') {
        const shown = this.showOsWeb(opts);
        if (sound) this.playChime();
        if (shown) return { channel: 'os-web', sounded: sound, permission };
        // Construction failed (some engines require a ServiceWorker) → in-app.
        this.showToast(opts);
        return { channel: 'in-app', sounded: sound, permission };
      }
      // Denied or dismissed → in-app fallback.
      if (sound) this.playChime();
      this.showToast(opts);
      return { channel: 'in-app', sounded: sound, permission };
    }

    // 3) No OS notification surface at all.
    if (sound) this.playChime();
    this.showToast(opts);
    return { channel: 'in-app', sounded: sound, permission: 'unsupported' };
  }

  /** Show an in-app toast only — for non-time-critical UI messaging (no OS notification, no sound by default). */
  toast(opts: NotifyOptions): string {
    return this.showToast({ severity: 'info', assertive: false, sound: false, ...opts });
  }

  /** Begin dismissing a toast (plays its exit transition, then removes it). Idempotent. */
  dismiss(id: string): void {
    const current = this._toasts().find((t) => t.id === id);
    if (!current || current.leaving) return;

    this.clearTimer(id);
    this._toasts.update((list) => list.map((t) => (t.id === id ? { ...t, leaving: true } : t)));

    const removeAfter = motionMs(TOAST_EXIT_MS); // 0 under reduce-motion
    const remove = () => {
      this.timers.delete(id);
      this._toasts.update((list) => list.filter((t) => t.id !== id));
    };
    if (removeAfter <= 0) remove();
    else this.timers.set(id, setTimeout(remove, removeAfter));
  }

  /** Remove every toast immediately (e.g. on route/skill teardown). */
  clearToasts(): void {
    this.timers.forEach((t) => clearTimeout(t));
    this.timers.clear();
    this._toasts.set([]);
  }

  /** Current OS-notification permission on the web path (`'default'` when unknown / in Tauri). */
  permission(): NotificationPermission | 'unsupported' {
    return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
  }

  // ── web notification permission ────────────────────────────────────────────

  private ensureWebPermission(): Promise<NotificationPermission> {
    if (Notification.permission !== 'default') return Promise.resolve(Notification.permission);
    if (this.permissionRequest) return this.permissionRequest;

    // Support both the modern promise form and the legacy callback form (older Safari).
    this.permissionRequest = new Promise<NotificationPermission>((resolve) => {
      try {
        const maybe = Notification.requestPermission((perm) => resolve(perm)) as
          | Promise<NotificationPermission>
          | undefined;
        if (maybe && typeof maybe.then === 'function') {
          maybe.then(resolve, () => resolve('denied'));
        }
      } catch {
        resolve('denied');
      }
    });
    return this.permissionRequest;
  }

  private showOsWeb(opts: NotifyOptions): boolean {
    try {
      // eslint-disable-next-line no-new -- the OS owns the notification's lifecycle
      new Notification(opts.title, { body: opts.body, tag: opts.tag });
      return true;
    } catch {
      return false;
    }
  }

  // ── in-app toast ────────────────────────────────────────────────────────────

  private showToast(opts: NotifyOptions): string {
    const severity: ToastSeverity = opts.severity ?? 'attention';
    const assertive = opts.assertive ?? (severity === 'critical' || severity === 'attention');
    const id = newId();
    this._toasts.update((list) => [
      ...list,
      { id, title: opts.title, body: opts.body, severity, assertive, leaving: false },
    ]);

    const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (timeout > 0 && Number.isFinite(timeout)) {
      this.timers.set(id, setTimeout(() => this.dismiss(id), timeout));
    }
    return id;
  }

  private clearTimer(id: string): void {
    const t = this.timers.get(id);
    if (t) {
      clearTimeout(t);
      this.timers.delete(id);
    }
  }

  // ── chime (WebAudio, no bundled asset — offline-friendly) ────────────────────

  private playChime(): void {
    try {
      const Ctx =
        typeof window === 'undefined'
          ? null
          : window.AudioContext ||
            (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ||
            null;
      if (!Ctx) return;
      if (!this.audioCtx) this.audioCtx = new Ctx();
      const ctx = this.audioCtx;
      if (ctx.state === 'suspended') void ctx.resume();

      const now = ctx.currentTime;
      // Two short rising pings — a recognisable "done" cue, ~0.28s total.
      for (const [freq, at] of [[880, 0], [1320, 0.14]] as const) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        const t0 = now + at;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.15, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.13);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t0);
        osc.stop(t0 + 0.14);
      }
    } catch {
      // Autoplay blocked before any user gesture, or WebAudio unsupported — the
      // visual notification/toast still conveys the alert.
    }
  }

  private teardown(): void {
    this.timers.forEach((t) => clearTimeout(t));
    this.timers.clear();
    try {
      void this.audioCtx?.close();
    } catch {
      /* already closed */
    }
    this.audioCtx = null;
  }
}

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `toast_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
