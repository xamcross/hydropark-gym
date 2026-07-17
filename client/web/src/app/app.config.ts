import { ApplicationConfig, Provider, provideZoneChangeDetection } from '@angular/core';
import { provideIpc } from './ipc/ipc.provider';
import { isTauriRuntime } from './ipc/tauri-ipc.service';
import { provideCatalog } from './marketplace/catalog.providers';
import { STORAGE_BACKEND } from './shared/persistence/storage-backend';
import { SqliteStorageBackend } from './shared/persistence/sqlite-storage.backend';

// Task 12 (SPEC §9): panel/UI state persists to the on-device SQLite store
// (via IPC) under a real Tauri runtime; everywhere else (e.g. `ng serve` in a
// browser tab) the STORAGE_BACKEND token's own default factory keeps picking
// localStorage — falling back to in-memory — exactly as it already does
// (see storage-backend.ts's `createDefaultStorageBackend`). No caller of
// PersistenceService/STORAGE_BACKEND needs to know which one it got.
const storageBackendProviders: Provider[] = isTauriRuntime()
  ? [{ provide: STORAGE_BACKEND, useClass: SqliteStorageBackend }]
  : [];

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideIpc(),
    // Marketplace catalog seam — real IPC adapter under Tauri, stub in a browser.
    provideCatalog(),
    ...storageBackendProviders
  ]
};
