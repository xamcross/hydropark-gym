/* =============================================================================
   HYDROPARK — SQLITE STORAGE BACKEND  (Task 12 · SPEC §9, §15)
   -----------------------------------------------------------------------------
   The on-device SQLite implementation of the `StorageBackend` seam
   (./storage-backend.ts), reached over Tauri IPC via the `ui_state_save` /
   `ui_state_load` commands (client/src-tauri/src/main.rs), which forward to
   the EXISTING `store.rs` `panel_state` table (Task 10.1/.4) — no new
   persistence logic added on the Rust side, only the IPC wiring (Task 12).

   NO SYNC/ASYNC RECONCILIATION NEEDED. `StorageBackend` (persistence.model.ts)
   is ALREADY fully async — every method returns a `Promise` — specifically so
   an IPC-backed implementation drops in without touching a single caller (see
   that file's own header comment: "so the eventual on-device SQLite store —
   reached over async Tauri IPC — drops in behind the same interface WITHOUT
   touching a single caller"). This class simply fulfils those Promises with
   real `await ipc.invoke(...)` calls; no write-through cache / hydrate-once
   in-memory mirror workaround is required or used.

   KEY <-> AGENT_ID MAPPING. `panel_state` is a generic
   `(agent_id TEXT PRIMARY KEY, body TEXT)` table — store.rs's own doc comment
   calls the body "opaque per-agent UI panel layout/state". This backend
   exploits that genericity directly: the full `StorageBackend` key string
   (e.g. `hydropark:agent:<id>:snapshot:v1` or `hydropark:persist-index:v1` —
   see persistence.model.ts's `snapshotKey`/`indexKey`) is passed as
   `agent_id` VERBATIM (it's just a primary-key string to store.rs, not
   necessarily a real agent id), and the opaque string VALUE is carried as a
   JSON string `Value` so it round-trips through the `body: Value` slot
   untouched. This backend never parses or interprets the value — it only
   ever WRITES a JSON string and only ever treats a returned JSON STRING as a
   hit; anything else (see below) means absent.

   REMOVE, WITHOUT A DELETE COMMAND. Task 12 adds exactly two commands —
   `ui_state_save` / `ui_state_load` — mirroring only the two `store.rs`
   methods that already existed (`save_panel_state`/`load_panel_state`).
   There is no `delete_panel_state`, and this ticket does not add one or
   otherwise touch store.rs's core logic. `remove(key)` is therefore
   implemented as `ui_state_save(key, null)` — a JSON NULL, not a string.
   `get(key)` treats any non-string stored value (in practice: exactly this
   null) as absent, so the `StorageBackend` CONTRACT ("get after remove
   resolves to null") holds exactly. The SQLite row itself is NOT deleted
   (its body becomes `null`) — a documented storage-layer limitation, not a
   seam-contract violation: no caller can observe the difference. A future
   `ui_state_delete` command would be needed to actually reclaim the row
   (e.g. for a full-wipe / right-to-erasure flow), should that ever matter.

   keys() IS UNSUPPORTED OVER THIS SEAM. Enumerating stored keys would need a
   new "list panel_state ids" command Task 12 does not add. Per
   storage-backend.ts's own doc comment ("for sweeps / index rebuilds") this
   was always a forward-looking extension point, not a wired one — and
   PersistenceService (the ONLY current caller of the StorageBackend seam)
   never actually calls `.keys()`; the durable opt-in index (`indexKey()`) is
   what a real sweep uses instead. Returning `[]` is therefore a documented
   no-op, not a silent miswiring of a seam anything currently depends on.
   ============================================================================= */

import { Injectable, inject } from '@angular/core';
import { IPC_PORT } from '../../ipc/ipc.port';
import type { StorageBackend } from './persistence.model';

@Injectable({ providedIn: 'root' })
export class SqliteStorageBackend implements StorageBackend {
  private readonly ipc = inject(IPC_PORT);

  /** Resolves the JSON-string value stored under `key`, or `null` if absent. */
  async get(key: string): Promise<string | null> {
    const body = await this.ipc.invoke('ui_state_load', { agent_id: key });
    return typeof body === 'string' ? body : null;
  }

  /** Upsert `value` under `key` (see file header for the key/value <-> agent_id/body mapping). */
  async set(key: string, value: string): Promise<void> {
    await this.ipc.invoke('ui_state_save', { agent_id: key, body: value });
  }

  /** Clears the value under `key` (see file header: save-null, not a delete command). */
  async remove(key: string): Promise<void> {
    await this.ipc.invoke('ui_state_save', { agent_id: key, body: null });
  }

  /** Unsupported over this seam (see file header) — always empty, never a partial/misleading list. */
  async keys(_prefix: string): Promise<string[]> {
    return [];
  }
}
