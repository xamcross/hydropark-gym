import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideIpc } from './ipc/ipc.provider';

export const appConfig: ApplicationConfig = {
  providers: [provideZoneChangeDetection({ eventCoalescing: true }), provideIpc()]
};
