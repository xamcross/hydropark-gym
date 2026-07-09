import { InjectionToken } from '@angular/core';
import { IpcCommand, IpcCommandMap, IpcEvent, IpcEventMap } from './contract';

/** Unsubscribe function returned by `IpcPort.on`. */
export type Unlisten = () => void;

/**
 * The one seam every part of the Angular app goes through to reach the
 * Rust core. Two implementations exist:
 *  - `TauriIpcService` — real `invoke`/`listen` over the Tauri bridge.
 *  - `MockIpcService`  — in-browser simulation (no Rust, no model needed)
 *    so `ng serve` / `ng build` work standalone (see client/README.md).
 *
 * The app picks one at bootstrap based on whether it's actually running
 * inside a Tauri webview (see `ipc.provider.ts`) — nothing else in the
 * app needs to know which one it got.
 */
export abstract class IpcPort {
  abstract invoke<K extends IpcCommand>(
    cmd: K,
    args: IpcCommandMap[K]['args']
  ): Promise<IpcCommandMap[K]['result']>;

  abstract on<K extends IpcEvent>(
    event: K,
    handler: (payload: IpcEventMap[K]) => void
  ): Unlisten;
}

export const IPC_PORT = new InjectionToken<IpcPort>('IPC_PORT');
