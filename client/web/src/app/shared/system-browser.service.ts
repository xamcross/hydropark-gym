import { Injectable, inject } from '@angular/core';
import { IPC_PORT } from '../ipc/ipc.port';
import { isTauriRuntime } from '../ipc/tauri-ipc.service';

/**
 * The one seam for handing a URL to the OS DEFAULT browser (P1-08.6 — the
 * checkout hand-off). A webview must NOT navigate itself to the payment page;
 * checkout runs in the real browser and returns via the `purchase://callback`
 * deep link.
 *
 * Delivery, first that works wins:
 *   1. **Tauri** — invoke the Rust-owned `open_external` command (the core owns
 *      the actual `open`, exactly like `notify`). This is the correct surface in
 *      the shell; a webview `window.open` is unreliable there.
 *   2. **Web** — a plain browser (`ng serve`) has no Rust core: best-effort
 *      `window.open` in a new tab. Popup blockers may suppress it when the open
 *      happens after an `await` (no longer a direct user gesture) — that is fine,
 *      the purchase flow still settles via `order_get` polling + the mock's
 *      simulated callback.
 */
@Injectable({ providedIn: 'root' })
export class SystemBrowserService {
  private readonly ipc = inject(IPC_PORT, { optional: true });

  /** Open `url` in the system browser. Never throws — a failed hand-off is non-fatal. */
  async open(url: string): Promise<void> {
    if (isTauriRuntime() && this.ipc) {
      try {
        await this.ipc.invoke('open_external', { url });
        return;
      } catch {
        // Command not registered yet / bridge error — fall through to window.open.
      }
    }
    try {
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      // Popup blocked or no window — the flow still settles via poll + callback.
    }
  }
}
