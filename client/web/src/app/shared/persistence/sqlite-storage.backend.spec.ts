import { TestBed } from '@angular/core/testing';
import { SqliteStorageBackend } from './sqlite-storage.backend';
import { IPC_PORT, IpcPort, Unlisten } from '../../ipc/ipc.port';
import { IpcCommand, IpcCommandMap, IpcEvent } from '../../ipc/contract';

/**
 * Records every invoked command (in call order) and stands in for the
 * on-device `panel_state` table (store.rs) exactly as `mock-ipc.service.ts`'s
 * own `ui_state_save`/`ui_state_load` handlers do: a generic
 * `agent_id -> opaque body` upsert, no interpretation of `body`. This is
 * intentionally NOT `MockIpcService` — it's a minimal hand-rolled double, the
 * same pattern `templates.service.spec.ts` uses, scoped to exactly the two
 * commands this backend calls (any other command is a bug in this backend).
 */
class ScriptedIpc extends IpcPort {
  readonly calls: { cmd: IpcCommand; args: unknown }[] = [];
  private readonly rows = new Map<string, unknown>();

  async invoke<K extends IpcCommand>(cmd: K, args: IpcCommandMap[K]['args']): Promise<IpcCommandMap[K]['result']> {
    this.calls.push({ cmd, args });
    switch (cmd) {
      case 'ui_state_save': {
        const a = args as IpcCommandMap['ui_state_save']['args'];
        this.rows.set(a.agent_id, a.body);
        return undefined as IpcCommandMap[K]['result'];
      }
      case 'ui_state_load': {
        const a = args as IpcCommandMap['ui_state_load']['args'];
        return (this.rows.has(a.agent_id) ? this.rows.get(a.agent_id) : null) as IpcCommandMap[K]['result'];
      }
      default:
        throw new Error(`ScriptedIpc: unexpected command for SqliteStorageBackend: "${String(cmd)}"`);
    }
  }

  on<K extends IpcEvent>(): Unlisten {
    return () => undefined;
  }
}

describe('SqliteStorageBackend (Task 12, SPEC §9)', () => {
  let ipc: ScriptedIpc;
  let backend: SqliteStorageBackend;

  beforeEach(() => {
    ipc = new ScriptedIpc();
    TestBed.configureTestingModule({ providers: [{ provide: IPC_PORT, useValue: ipc }] });
    backend = TestBed.inject(SqliteStorageBackend);
  });

  // --- the async contract itself (no sync/async reconciliation was needed —
  // StorageBackend was already Promise-based end to end; these confirm every
  // method genuinely returns a Promise the caller must await, same as
  // LocalStorageBackend) ---------------------------------------------------

  it('every method returns a Promise', () => {
    expect(backend.get('k')).toBeInstanceOf(Promise);
    expect(backend.set('k', 'v')).toBeInstanceOf(Promise);
    expect(backend.remove('k')).toBeInstanceOf(Promise);
    expect(backend.keys('')).toBeInstanceOf(Promise);
  });

  // --- save routes to ui_state_save, load hydrates from ui_state_load -----

  it('get() resolves null before any save', async () => {
    expect(await backend.get('hydropark:agent:a1:snapshot:v1')).toBeNull();
  });

  it('set() routes to ui_state_save keyed by the storage key as agent_id', async () => {
    await backend.set('hydropark:agent:a1:snapshot:v1', '{"x":1}');
    expect(ipc.calls).toEqual([
      { cmd: 'ui_state_save', args: { agent_id: 'hydropark:agent:a1:snapshot:v1', body: '{"x":1}' } },
    ]);
  });

  it('get() hydrates the value back from ui_state_load after a set()', async () => {
    await backend.set('hydropark:agent:a1:snapshot:v1', '{"x":1}');
    const loaded = await backend.get('hydropark:agent:a1:snapshot:v1');
    expect(loaded).toBe('{"x":1}');
    expect(ipc.calls[1].cmd).toBe('ui_state_load');
    expect(ipc.calls[1].args).toEqual({ agent_id: 'hydropark:agent:a1:snapshot:v1' });
  });

  it('round-trips an opaque string value exactly, like LocalStorageBackend', async () => {
    const value = JSON.stringify({ schemaVersion: 1, agentId: 'a1', slots: {}, layout: [], widgets: {} });
    await backend.set('k', value);
    expect(await backend.get('k')).toBe(value);
  });

  it('keeps different keys isolated from each other', async () => {
    await backend.set('agent-1', 'one');
    await backend.set('agent-2', 'two');
    expect(await backend.get('agent-1')).toBe('one');
    expect(await backend.get('agent-2')).toBe('two');
  });

  it('a later set() under the same key replaces the prior value (upsert)', async () => {
    await backend.set('k', 'first');
    await backend.set('k', 'second');
    expect(await backend.get('k')).toBe('second');
  });

  // --- remove(): implemented as ui_state_save(key, null) — no delete command
  // exists (see the backend's file header) — the CONTRACT still holds -------

  it('remove() clears the value (get() resolves null afterwards)', async () => {
    await backend.set('k', 'v');
    await backend.remove('k');
    expect(await backend.get('k')).toBeNull();
  });

  it('remove() is implemented as a save with a JSON null body, not a bespoke delete command', async () => {
    await backend.set('k', 'v');
    await backend.remove('k');
    expect(ipc.calls[ipc.calls.length - 1]).toEqual({ cmd: 'ui_state_save', args: { agent_id: 'k', body: null } });
  });

  // --- keys(): undocumented/unsupported over this seam (no caller uses it) -

  it('keys() always resolves empty (unsupported over this seam, documented no-op)', async () => {
    await backend.set('hydropark:agent:a1:snapshot:v1', 'x');
    expect(await backend.keys('hydropark:agent:')).toEqual([]);
  });

  // --- defensive: a non-string stored body never throws, resolves to null --

  it('a non-string stored body (defensive) resolves to null on get(), never throws', async () => {
    await ipc.invoke('ui_state_save', { agent_id: 'weird', body: { unexpected: true } });
    await expectAsync(backend.get('weird')).toBeResolvedTo(null);
  });
});
