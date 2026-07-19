/* =============================================================================
   HYDROPARK — STORAGE BACKEND SEAM  (P1-06.8 · SPEC §9.9, §15)
   -----------------------------------------------------------------------------
   The DI wiring for the {@link StorageBackend} seam defined in
   persistence.model.ts. Ships two concrete backends — localStorage (default)
   and in-memory (tests / SSR / private-mode fallback) — and an injection token
   so P1-10's on-device SQLite backend can be provided in place WITHOUT touching
   any caller:

     { provide: STORAGE_BACKEND, useClass: SqliteStorageBackend }

   All backends are async (Promise-returning) so the sync localStorage impl and
   the async SQLite-over-Tauri-IPC impl share one interface. Everything here
   stays LOCAL — no value ever leaves the device (§15).
   ============================================================================= */

import { InjectionToken } from '@angular/core';
import type { StorageBackend } from './persistence.model';

/**
 * DI token for the persistence backend. Defaults to localStorage (falling back
 * to in-memory when the DOM/localStorage is unavailable or throws — e.g. Safari
 * private mode, SSR). Override in P1-10 to swap in the SQLite store.
 */
export const STORAGE_BACKEND = new InjectionToken<StorageBackend>('hydropark.storage-backend', {
  providedIn: 'root',
  factory: () => createDefaultStorageBackend(),
});

/** Pick the best available local backend at runtime. */
export function createDefaultStorageBackend(): StorageBackend {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      // Touch it — access itself throws under Safari private mode / disabled storage.
      const probe = '__hp_probe__';
      window.localStorage.setItem(probe, '1');
      window.localStorage.removeItem(probe);
      return new LocalStorageBackend(window.localStorage);
    }
  } catch {
    // fall through to memory
  }
  return new InMemoryStorageBackend();
}

/**
 * localStorage-backed {@link StorageBackend}. Synchronous under the hood; wraps
 * every op in a resolved Promise so it is interchangeable with the async SQLite
 * backend. Read/write failures (quota, disabled storage) degrade gracefully
 * rather than throwing into a save/load.
 */
export class LocalStorageBackend implements StorageBackend {
  constructor(private readonly store: Storage) {}

  get(key: string): Promise<string | null> {
    try {
      return Promise.resolve(this.store.getItem(key));
    } catch {
      return Promise.resolve(null);
    }
  }

  set(key: string, value: string): Promise<void> {
    try {
      this.store.setItem(key, value);
    } catch {
      // quota / disabled — best-effort; session state is unaffected
    }
    return Promise.resolve();
  }

  remove(key: string): Promise<void> {
    try {
      this.store.removeItem(key);
    } catch {
      // ignore
    }
    return Promise.resolve();
  }

  keys(prefix: string): Promise<string[]> {
    const out: string[] = [];
    try {
      for (let i = 0; i < this.store.length; i++) {
        const key = this.store.key(i);
        if (key !== null && key.startsWith(prefix)) out.push(key);
      }
    } catch {
      // ignore — return whatever we gathered
    }
    return Promise.resolve(out);
  }
}

/** Map-backed {@link StorageBackend} — used by tests, and the fallback when no DOM storage exists. */
export class InMemoryStorageBackend implements StorageBackend {
  private readonly map = new Map<string, string>();

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.map.get(key) ?? null);
  }

  set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
    return Promise.resolve();
  }

  remove(key: string): Promise<void> {
    this.map.delete(key);
    return Promise.resolve();
  }

  keys(prefix: string): Promise<string[]> {
    const out: string[] = [];
    for (const key of this.map.keys()) {
      if (key.startsWith(prefix)) out.push(key);
    }
    return Promise.resolve(out);
  }
}
