/**
 * Shared shapes for the notification subsystem (P1-06.7 / SPEC §9.7).
 * Kept framework-free so both the service and the toast component depend on
 * types only, not on each other's implementation.
 */

/**
 * In-app toast tone. Maps to the brand's semantic triad (tokens.css):
 *  - `critical`  → rust ("no" / error)
 *  - `attention` → sulphur ("careful" — the default for time-critical alerts)
 *  - `info`      → neutral accent
 *  - `success`   → chalk/steel "fine"
 */
export type ToastSeverity = 'critical' | 'attention' | 'info' | 'success';

export interface Toast {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly severity: ToastSeverity;
  /**
   * true  → rendered with `role="alert"` + assertive live region (interrupts),
   * false → `role="status"` + polite (announced at the next opportunity).
   */
  readonly assertive: boolean;
  /** Set true for the duration of the exit transition, immediately before removal. */
  readonly leaving: boolean;
}

export interface NotifyOptions {
  title: string;
  body: string;
  /** Play a short chime alongside the alert. Default true (time-critical events). */
  sound?: boolean;
  /** In-app fallback tone + a11y politeness. Default `attention`. */
  severity?: ToastSeverity;
  /** Override the assertive/polite mapping otherwise derived from `severity`. */
  assertive?: boolean;
  /** Auto-dismiss delay for the in-app toast, in ms. Default 6000; `0`/`Infinity` = sticky. */
  timeoutMs?: number;
  /** OS-notification dedupe tag — repeats with the same tag collapse (web + Tauri). */
  tag?: string;
}

/** Which surface actually delivered a `notify()` call. */
export type NotifyChannel = 'os-tauri' | 'os-web' | 'in-app';

export interface NotifyOutcome {
  channel: NotifyChannel;
  /** Whether a chime was attempted (may still be blocked by autoplay policy). */
  sounded: boolean;
  /**
   * OS permission state at delivery time:
   *  - web path → the `Notification.permission` value,
   *  - `'tauri'` → delivered through the Tauri/Rust OS-notification command,
   *  - `'unsupported'` → no Notification API and not in Tauri (in-app only).
   */
  permission: NotificationPermission | 'tauri' | 'unsupported';
}
