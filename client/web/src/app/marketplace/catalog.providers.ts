import { EnvironmentProviders, makeEnvironmentProviders } from '@angular/core';
import { CATALOG_PORT } from './catalog.port';
import { StubCatalogPort } from './catalog-stub.adapter';

/**
 * Binds {@link CATALOG_PORT} to the in-memory {@link StubCatalogPort} so the
 * marketplace components build and run standalone with no backend. The real
 * HTTP/IPC adapter (a later ticket) will swap the `useClass` here — nothing
 * downstream changes. Mirror of `provideIpc()`.
 *
 * Usage (host, later): add `provideCatalogStub()` to the app/route providers.
 */
export function provideCatalogStub(): EnvironmentProviders {
  return makeEnvironmentProviders([{ provide: CATALOG_PORT, useClass: StubCatalogPort }]);
}
