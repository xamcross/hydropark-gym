import { EnvironmentProviders, Provider, makeEnvironmentProviders } from '@angular/core';
import { isTauriRuntime } from '../ipc/tauri-ipc.service';
import { CATALOG_PORT } from './catalog.port';
import { StubCatalogPort } from './catalog-stub.adapter';
import { CatalogIpcAdapter } from './catalog-ipc.adapter';

/**
 * Binds {@link CATALOG_PORT} to the in-memory {@link StubCatalogPort} so the
 * marketplace components build and run standalone with no backend. Kept for
 * dev/offline use and tests. Mirror of the mock side of `provideIpc()`.
 */
export function provideCatalogStub(): EnvironmentProviders {
  return makeEnvironmentProviders([{ provide: CATALOG_PORT, useClass: StubCatalogPort }]);
}

/**
 * Binds {@link CATALOG_PORT} to the REAL {@link CatalogIpcAdapter} (over the
 * `catalog_list`/`catalog_detail`/`entitlements_get` IPC commands) when the app
 * is hosted in a Tauri webview, and to the {@link StubCatalogPort} otherwise
 * (`ng serve` in a browser, or any environment without the Rust core). Exactly
 * the runtime split `provideIpc()` uses — nothing downstream knows which it got.
 */
export function provideCatalog(): EnvironmentProviders {
  const provider: Provider = isTauriRuntime()
    ? { provide: CATALOG_PORT, useClass: CatalogIpcAdapter }
    : { provide: CATALOG_PORT, useClass: StubCatalogPort };
  return makeEnvironmentProviders([provider]);
}
