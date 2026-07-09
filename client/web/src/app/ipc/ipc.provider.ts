import { EnvironmentProviders, Provider, makeEnvironmentProviders } from '@angular/core';
import { IPC_PORT } from './ipc.port';
import { MockIpcService } from './mock-ipc.service';
import { TauriIpcService, isTauriRuntime } from './tauri-ipc.service';

/**
 * Binds `IPC_PORT` to the real Tauri bridge when the app is actually
 * hosted in a Tauri webview, and to the in-browser mock otherwise — e.g.
 * `ng serve` in a normal browser tab, or any environment without the
 * llama.cpp + Qwen model bundled (see client/README.md "What builds
 * today"). Nothing downstream needs to know which one it got.
 */
export function provideIpc(): EnvironmentProviders {
  const providers: Provider[] = isTauriRuntime()
    ? [{ provide: IPC_PORT, useClass: TauriIpcService }]
    : [{ provide: IPC_PORT, useClass: MockIpcService }];
  return makeEnvironmentProviders(providers);
}
