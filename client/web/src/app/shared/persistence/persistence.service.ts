import { Injectable, computed, inject, signal } from '@angular/core';
import {
  AgentSnapshot,
  CaptureContext,
  LayoutPersistencePort,
  PersistIndex,
  SnapshotSource,
  applySnapshot,
  collectSnapshot,
  indexKey,
  layoutSource,
  parseIndex,
  parseSnapshot,
  serializeIndex,
  serializeSnapshot,
  snapshotKey,
} from './persistence.model';
import { STORAGE_BACKEND } from './storage-backend';

/**
 * PersistenceService (P1-06.8 · SPEC §9.9, §15) — the stateful shell over the
 * pure persistence core. It owns the opt-in flags + the in-memory session cache
 * in signals, and drives a {@link StorageBackend} using the pure helpers in
 * persistence.model.ts.
 *
 * SESSION vs PERSISTENT (the whole model in two sentences):
 *   - SESSION scope is the DEFAULT: `save()` always mirrors the durable snapshot
 *     into an in-memory cache that is discarded when the app closes. Nothing
 *     touches disk. This is how §9.9 "session-scoped by default" is realised on
 *     the Angular side — the live signals in the feature services are the state;
 *     this cache just lets a mid-session persistence toggle capture current work.
 *   - PERSISTENT scope is OPT-IN per agent/template: when `isPersistent(agentId)`
 *     is on, `save()` ALSO writes the snapshot to the backend (localStorage now,
 *     SQLite in P1-10) under a namespaced, versioned key. The opt-in flags live
 *     in a small durable index so a cold start knows which agents to rehydrate.
 *
 * WHAT IS / ISN'T persisted — see {@link AgentSnapshot}. In short: durable
 * shared-state slots + layout overrides + widget UI state ARE; conversation
 * transcript is NOT, unless the SEPARATE transcript opt-in is on (§15). The
 * transcript exclusion is enforced in the pure core (collect/apply), so it holds
 * regardless of what a source emits.
 *
 * COMPOSING STATE: feature services (LayoutService, the shared-store, widgets)
 * register a {@link SnapshotSource} that pulls their durable slice and pushes it
 * back. `useLayout()` is a one-liner adapter over `LayoutService`'s existing
 * `serializeOverrides()`/`applyOverrides()` seam (§9.5). Because LayoutService is
 * component-scoped (not root), the shell registers ITS instance at mount and
 * disposes on destroy.
 *
 * `providedIn: 'root'` — one persistence coordinator for the app.
 */
@Injectable({ providedIn: 'root' })
export class PersistenceService {
  private readonly backend = inject(STORAGE_BACKEND);

  /** Registered durable-state sources (layout, shared-store, widgets…). */
  private readonly sources = new Set<SnapshotSource>();

  /** SESSION scope: the in-memory snapshot per agent. Discarded when the app closes. */
  private readonly _sessionCache = signal<ReadonlyMap<string, AgentSnapshot>>(new Map());
  /** Agents with base persistence opted in (durable). Mirrored to the index. */
  private readonly _persistentIds = signal<ReadonlySet<string>>(new Set());
  /** Agents with the SEPARATE transcript opt-in on (subset of persistent, §15). */
  private readonly _transcriptIds = signal<ReadonlySet<string>>(new Set());
  /** True once the durable index has been read at startup. */
  private readonly _ready = signal(false);

  /** Sorted list of agents currently opted into persistence (for a startup preload sweep). */
  readonly persistentAgentIds = computed<string[]>(() => [...this._persistentIds()].sort());
  /** Reactive readiness flag. `whenReady()` is the awaitable form. */
  readonly ready = computed<boolean>(() => this._ready());

  private readonly readyPromise: Promise<void>;

  constructor() {
    this.readyPromise = this.hydrateIndex();
  }

  /** Resolves once the durable opt-in index has been loaded — `load()` awaits this. */
  whenReady(): Promise<void> {
    return this.readyPromise;
  }

  // --- registration --------------------------------------------------------

  /** Register a durable-state source. Returns a disposer (call on component destroy). */
  registerSource(source: SnapshotSource): () => void {
    this.sources.add(source);
    return () => {
      this.sources.delete(source);
    };
  }

  /**
   * Convenience: register a {@link LayoutService}-shaped port as the 'layout'
   * source, composing its existing serialize/apply seam. Returns a disposer.
   */
  useLayout(layout: LayoutPersistencePort): () => void {
    return this.registerSource(layoutSource(layout));
  }

  // --- opt-in toggles ------------------------------------------------------

  /** Whether this agent/template persists locally (default false → session-scoped). */
  isPersistent(agentId: string): boolean {
    return this._persistentIds().has(agentId);
  }

  /** Whether the SEPARATE transcript opt-in is on for this agent (§15). */
  isTranscriptPersistent(agentId: string): boolean {
    return this._transcriptIds().has(agentId);
  }

  /**
   * Turn base persistence on/off for an agent.
   *   - on  → capture current session state to disk immediately, record in index.
   *   - off → drop the durable snapshot (session cache survives for the session),
   *           and cascade off the transcript sub-opt-in.
   */
  async setPersistent(agentId: string, on: boolean): Promise<void> {
    const next = new Set(this._persistentIds());
    if (on) next.add(agentId);
    else next.delete(agentId);
    this._persistentIds.set(next);

    if (on) {
      await this.save(agentId);
    } else {
      if (this._transcriptIds().has(agentId)) this.setTranscriptFlag(agentId, false);
      await this.backend.remove(snapshotKey(agentId));
    }
    await this.persistIndex();
  }

  /** Flip base persistence. */
  togglePersistence(agentId: string): Promise<void> {
    return this.setPersistent(agentId, !this.isPersistent(agentId));
  }

  /**
   * Turn the SEPARATE transcript opt-in on/off (§15). Turning it on implies base
   * persistence (a transcript can't persist without its agent), so base is
   * enabled first if needed. Re-saves so the change takes effect at once.
   */
  async setTranscriptPersistent(agentId: string, on: boolean): Promise<void> {
    if (on && !this.isPersistent(agentId)) {
      await this.setPersistent(agentId, true);
    }
    this.setTranscriptFlag(agentId, on);
    await this.persistIndex();
    if (this.isPersistent(agentId)) await this.save(agentId);
  }

  // --- core API: save / load / clear ---------------------------------------

  /**
   * Capture the durable snapshot from all registered sources into the session
   * cache (always), and — if this agent is persistent — write it to the backend.
   * Returns the captured snapshot.
   */
  async save(agentId: string): Promise<AgentSnapshot> {
    const snapshot = collectSnapshot(this.sources, this.ctxFor(agentId));
    this.cachePut(agentId, snapshot);
    if (this.isPersistent(agentId)) {
      await this.backend.set(snapshotKey(agentId), serializeSnapshot(snapshot));
    }
    return snapshot;
  }

  /**
   * Load an agent's snapshot and apply it to the registered sources. Session
   * cache wins (in-session edits beat a stale disk copy); otherwise, for a
   * persistent agent, read + migrate-on-load from the backend. Returns the
   * applied snapshot, or `null` when there is nothing to restore (live state is
   * then left untouched).
   */
  async load(agentId: string): Promise<AgentSnapshot | null> {
    await this.whenReady();

    let snapshot = this._sessionCache().get(agentId) ?? null;
    if (!snapshot && this.isPersistent(agentId)) {
      const raw = await this.backend.get(snapshotKey(agentId));
      snapshot = parseSnapshot(raw, agentId); // parseSnapshot runs the versioned migrate-on-load
      if (snapshot) this.cachePut(agentId, snapshot);
    }

    if (snapshot) applySnapshot(this.sources, snapshot, this.ctxFor(agentId));
    return snapshot;
  }

  /**
   * Forget this agent's SAVED state: drop the session cache entry and the
   * durable snapshot. The opt-in PREFERENCE is left intact (a subsequent `save`
   * re-persists); use `setPersistent(agentId, false)` to turn persistence off.
   * Live UI signals are untouched — the caller resets those if desired.
   */
  async clear(agentId: string): Promise<void> {
    this.cacheDelete(agentId);
    await this.backend.remove(snapshotKey(agentId));
  }

  // --- internals -----------------------------------------------------------

  private ctxFor(agentId: string): CaptureContext {
    return {
      agentId,
      persistTranscript: this._persistentIds().has(agentId) && this._transcriptIds().has(agentId),
    };
  }

  private setTranscriptFlag(agentId: string, on: boolean): void {
    const next = new Set(this._transcriptIds());
    if (on) next.add(agentId);
    else next.delete(agentId);
    this._transcriptIds.set(next);
  }

  private cachePut(agentId: string, snapshot: AgentSnapshot): void {
    const map = new Map(this._sessionCache());
    map.set(agentId, snapshot);
    this._sessionCache.set(map);
  }

  private cacheDelete(agentId: string): void {
    const map = new Map(this._sessionCache());
    if (map.delete(agentId)) this._sessionCache.set(map);
  }

  private async hydrateIndex(): Promise<void> {
    try {
      const raw = await this.backend.get(indexKey());
      const index = parseIndex(raw);
      this._persistentIds.set(new Set(index.persistent));
      this._transcriptIds.set(new Set(index.transcript));
    } catch {
      // start with an empty (all-session-scoped) index
    } finally {
      this._ready.set(true);
    }
  }

  private async persistIndex(): Promise<void> {
    const index: PersistIndex = {
      persistent: [...this._persistentIds()],
      transcript: [...this._transcriptIds()],
    };
    await this.backend.set(indexKey(), serializeIndex(index));
  }
}
