import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { IpcCommand, IpcCommandMap, IpcEvent, IpcEventMap } from './contract';
import { IpcPort, Unlisten } from './ipc.port';

/**
 * Real Rust ↔ Angular bridge. Thin — all it does is forward to
 * `@tauri-apps/api`, typed against the shared contract. No business logic
 * lives here; that's the point of the seam.
 *
 * Only usable inside an actual Tauri webview. `isTauriRuntime()` below is
 * how the app decides whether to provide this or `MockIpcService` — see
 * `ipc.provider.ts`.
 */
@Injectable()
export class TauriIpcService extends IpcPort {
  invoke<K extends IpcCommand>(
    cmd: K,
    args: IpcCommandMap[K]['args']
  ): Promise<IpcCommandMap[K]['result']> {
    return invoke(cmd, { args } as Record<string, unknown>);
  }

  on<K extends IpcEvent>(
    event: K,
    handler: (payload: IpcEventMap[K]) => void
  ): Unlisten {
    let unlistenFn: (() => void) | null = null;
    let cancelled = false;

    listen<IpcEventMap[K]>(event, (e) => handler(e.payload)).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlistenFn = fn;
      }
    });

    return () => {
      cancelled = true;
      unlistenFn?.();
    };
  }
}

/** True when the webview is actually hosted by the Tauri shell. */
export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}
