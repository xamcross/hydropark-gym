import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideIpc } from './ipc/ipc.provider';
import { provideCatalog } from './marketplace/catalog.providers';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideIpc(),
    // Marketplace catalog seam — real IPC adapter under Tauri, stub in a browser.
    provideCatalog()
  ]
};
