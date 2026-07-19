/* =============================================================================
   HYDROPARK — PERSISTENCE, PURE CORE  (P1-06.8 · SPEC §9.9, §15)
   -----------------------------------------------------------------------------
   The state/persistence rules expressed as SIDE-EFFECT-FREE data + functions.
   Nothing here imports Angular; every function is deterministic so the snapshot
   shape, the local-first exclusions, key namespacing, (de)serialisation and the
   migrate-on-load path are all unit-testable WITHOUT Karma/Jasmine.

   `PersistenceService` (./persistence.service.ts) is the thin stateful shell
   that holds the opt-in flags + session cache in signals and drives a
   `StorageBackend` (./storage-backend.ts) using these pure helpers.

   SPEC restated:
     §9.9  Widget/panel state is SESSION-SCOPED BY DEFAULT; a skill may OPT IN to
           persist it per agent/template. Shared-state slots (§8.3.4) persist
           with the agent when persistence is on. All state lives LOCALLY.
     §15   Local-first: conversations/agents/templates/panel-state/licenses live
           on-device. NO conversation data leaves the device, ever, in v1. So the
           transcript is NEVER in a snapshot unless a SEPARATE explicit opt-in is
           on — and even then it stays on-device (this file only shapes the blob;
           the backend is local).

   The default backend is localStorage; the on-device SQLite store (P1-10) drops
   in behind the same {@link StorageBackend} seam without touching any caller.
   ============================================================================= */

import type { PanelOverride } from '../layout/layout.model';

/** Key prefix for every Hydropark persistence entry (avoids collisions with other localStorage users). */
export const PERSISTENCE_NS = 'hydropark';

/**
 * Snapshot schema version. BUMP when the on-disk shape changes incompatibly and
 * add a migrator to {@link SNAPSHOT_MIGRATIONS}. The version is part of the
 * storage key ({@link snapshotKey}) AND recorded inside the blob, so a load can
 * both find the right slot and migrate an older blob forward.
 */
export const SNAPSHOT_SCHEMA_VERSION = 1 as const;

// -----------------------------------------------------------------------------
// The snapshot: exactly what CAN be persisted (durable subset only).
// -----------------------------------------------------------------------------

/**
 * The per-agent/template durable snapshot. This is the ONLY thing written to the
 * backend, and only for agents the user has explicitly opted in
 * ({@link CaptureContext}). Everything is JSON-serialisable.
 *
 * IS persisted (when opted in):
 *   - `slots`   — durable shared-state slot values (§8.3.4), e.g. ingredients /
 *                 packing_list. Only the slices a source declares durable.
 *   - `layout`  — panel dock overrides (collapsed / pinned / order / size),
 *                 sourced from `LayoutService.serializeOverrides()` (§9.5).
 *   - `widgets` — per-widget UI state (view prefs, unit toggle, expanded rows…).
 *
 * Is NOT persisted (local-first, §15):
 *   - `transcript` — conversation/chat content. Stays `null` unless the SEPARATE
 *                    transcript opt-in is on; enforced at collect AND apply time
 *                    so a misbehaving source can never leak it.
 *   - Ephemeral/derived state: running-timer countdowns (Rust-owned), streaming
 *     flags, sessionId, hardware probe, any secrets — sources simply don't emit
 *     these from `capture()`.
 */
export interface AgentSnapshot {
  readonly schemaVersion: number;
  readonly agentId: string;
  /** Epoch ms the snapshot was captured. */
  readonly savedAt: number;
  /** Durable shared-state slot values, keyed by slot name (§8.3.4). */
  readonly slots: Readonly<Record<string, unknown>>;
  /** Panel dock overrides (§9.5) — the output of `LayoutService.serializeOverrides()`. */
  readonly layout: readonly PanelOverride[];
  /** Per-widget UI state, keyed by widget/panel id. */
  readonly widgets: Readonly<Record<string, unknown>>;
  /** Conversation slice — `null` unless the separate transcript opt-in is on (§15). Opaque to this layer. */
  readonly transcript: unknown;
}

/**
 * A single source's contribution to a snapshot. Every field is OPTIONAL: a
 * source emits only the slices it owns. Records are shallow-merged across
 * sources; `layout` and `transcript` are last-writer-wins.
 */
export interface SnapshotContribution {
  slots?: Readonly<Record<string, unknown>>;
  layout?: readonly PanelOverride[];
  widgets?: Readonly<Record<string, unknown>>;
  /** Transcript slice — only honoured when `ctx.persistTranscript` is true; otherwise dropped. */
  transcript?: unknown;
}

/** Context handed to every source on capture/restore. */
export interface CaptureContext {
  readonly agentId: string;
  /**
   * Whether the SEPARATE transcript opt-in (§15) is active for this agent. When
   * false, any transcript contribution is dropped at collection time and never
   * handed back on restore — local-first, enforced at the boundary.
   */
  readonly persistTranscript: boolean;
}

/**
 * A pluggable durable-state SOURCE. Each stateful service (layout, shared-store,
 * a widget) registers ONE source that knows how to pull its DURABLE slice into a
 * snapshot and push it back on load. Sources own the "which slots/widgets are
 * durable" decision by simply not emitting the ephemeral ones.
 *
 * `capture`/`restore` must be side-effect-free w.r.t. persistence and tolerant
 * of partial/absent data — a source that throws is skipped, never aborting a
 * whole save/load.
 */
export interface SnapshotSource {
  /** Stable id for debugging/dedupe (e.g. 'layout', 'slots', 'timer-widget'). */
  readonly id: string;
  /** Contribute this source's durable slice. Return `{}` (or omit fields) to contribute nothing. */
  capture(ctx: CaptureContext): SnapshotContribution;
  /** Re-apply this source's slice from a loaded snapshot. */
  restore(snapshot: AgentSnapshot, ctx: CaptureContext): void;
}

/**
 * Structural port for the layout persistence seam — `LayoutService` already
 * satisfies this (see layout.service.ts `serializeOverrides` / `applyOverrides`),
 * so we compose it WITHOUT importing the (component-scoped) service or coupling
 * to it. Kept structural on purpose: a template store or a test double fits too.
 */
export interface LayoutPersistencePort {
  serializeOverrides(): PanelOverride[];
  applyOverrides(overrides: readonly PanelOverride[]): void;
}

/** Adapter: turn a {@link LayoutPersistencePort} into a {@link SnapshotSource}. */
export function layoutSource(layout: LayoutPersistencePort): SnapshotSource {
  return {
    id: 'layout',
    capture: () => ({ layout: layout.serializeOverrides() }),
    restore: (snapshot) => layout.applyOverrides(snapshot.layout),
  };
}

// -----------------------------------------------------------------------------
// Collect / apply: fold sources → snapshot, and snapshot → sources.
// -----------------------------------------------------------------------------

/** An all-empty snapshot for `agentId` at the current schema version. */
export function emptySnapshot(agentId: string): AgentSnapshot {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    agentId,
    savedAt: 0,
    slots: {},
    layout: [],
    widgets: {},
    transcript: null,
  };
}

/**
 * Fold every registered source into one snapshot. Records shallow-merge (later
 * source wins per key); `layout`/`transcript` are last-writer-wins. A source
 * that throws is skipped so one bad source never fails the save.
 *
 * §15 ENFORCEMENT: `transcript` is forced to `null` unless
 * `ctx.persistTranscript` — the collect boundary is the guarantee, independent
 * of what any source emits.
 *
 * INVARIANT: `collectSnapshot([], ctx)` deep-equals `emptySnapshot(agentId)`
 *            except for `savedAt`.
 */
export function collectSnapshot(sources: Iterable<SnapshotSource>, ctx: CaptureContext): AgentSnapshot {
  let slots: Record<string, unknown> = {};
  let widgets: Record<string, unknown> = {};
  let layout: readonly PanelOverride[] = [];
  let transcript: unknown = null;

  for (const source of sources) {
    let contribution: SnapshotContribution;
    try {
      contribution = source.capture(ctx) ?? {};
    } catch {
      continue;
    }
    if (contribution.slots) slots = { ...slots, ...contribution.slots };
    if (contribution.widgets) widgets = { ...widgets, ...contribution.widgets };
    if (contribution.layout) layout = contribution.layout;
    if (contribution.transcript !== undefined) transcript = contribution.transcript;
  }

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    agentId: ctx.agentId,
    savedAt: Date.now(),
    slots,
    layout,
    widgets,
    transcript: ctx.persistTranscript ? (transcript ?? null) : null,
  };
}

/**
 * Push a loaded snapshot back into every source. §15 is enforced on the way IN
 * too: unless opted in, the transcript is blanked before any source sees it. A
 * source that throws on restore is skipped so one bad source never fails a load.
 */
export function applySnapshot(sources: Iterable<SnapshotSource>, snapshot: AgentSnapshot, ctx: CaptureContext): void {
  const safe: AgentSnapshot = ctx.persistTranscript ? snapshot : { ...snapshot, transcript: null };
  for (const source of sources) {
    try {
      source.restore(safe, ctx);
    } catch {
      // one bad source shouldn't abort the whole load
    }
  }
}

// -----------------------------------------------------------------------------
// Key namespacing (per agent/template id + schema version).
// -----------------------------------------------------------------------------

/** Storage key for one agent's snapshot. `encodeURIComponent` keeps odd ids from forging the key shape. */
export function snapshotKey(agentId: string, version: number = SNAPSHOT_SCHEMA_VERSION): string {
  return `${PERSISTENCE_NS}:agent:${encodeURIComponent(agentId)}:snapshot:v${version}`;
}

/** Prefix that matches every agent snapshot key (any id / any version) — for `StorageBackend.keys` sweeps. */
export function snapshotKeyPrefix(): string {
  return `${PERSISTENCE_NS}:agent:`;
}

/** Storage key for the persistence INDEX (which agents are opted in). Versioned with the schema. */
export function indexKey(): string {
  return `${PERSISTENCE_NS}:persist-index:v${SNAPSHOT_SCHEMA_VERSION}`;
}

// -----------------------------------------------------------------------------
// (De)serialisation — defensive: bad/corrupt data yields null, never a throw.
// -----------------------------------------------------------------------------

export function serializeSnapshot(snapshot: AgentSnapshot): string {
  return JSON.stringify(snapshot);
}

/** Parse + migrate a stored blob. Returns `null` on absent/corrupt/undowngradable data (→ fall back to session state). */
export function parseSnapshot(serialized: string | null, agentId: string): AgentSnapshot | null {
  if (!serialized) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } catch {
    return null;
  }
  return migrateSnapshot(raw, agentId);
}

// -----------------------------------------------------------------------------
// Versioned migrate-on-load (stub with a live extension point).
// -----------------------------------------------------------------------------

/** A single-step migrator: take a raw blob at version N, return it at version N+1 (or higher). */
export type SnapshotMigrator = (raw: Record<string, unknown>) => Record<string, unknown>;

/**
 * Registry of forward migrators, keyed by the FROM version. Empty today (v1 is
 * the first shape); this is the seam so a future schema bump ships a stepwise
 * migration without touching callers. Example:
 *
 *   export const SNAPSHOT_MIGRATIONS = {
 *     1: (raw) => ({ ...raw, schemaVersion: 2, widgets: raw['widgets'] ?? {} }),
 *   };
 */
export const SNAPSHOT_MIGRATIONS: Readonly<Record<number, SnapshotMigrator>> = {};

/**
 * Migrate a raw blob up to {@link SNAPSHOT_SCHEMA_VERSION}, then normalise it.
 *   - not an object            → null (corrupt)
 *   - version > current        → null (written by a NEWER build; refuse to downgrade)
 *   - version < current, no migrator or migrator that fails to advance → null
 *   - otherwise                → a fully-shaped {@link AgentSnapshot}
 */
export function migrateSnapshot(raw: unknown, agentId: string): AgentSnapshot | null {
  if (!isRecord(raw)) return null;

  let current: Record<string, unknown> = raw;
  let version = typeof current['schemaVersion'] === 'number' ? (current['schemaVersion'] as number) : 0;

  if (version > SNAPSHOT_SCHEMA_VERSION) return null;

  while (version < SNAPSHOT_SCHEMA_VERSION) {
    const step = SNAPSHOT_MIGRATIONS[version];
    if (!step) return null;
    const migrated = step(current);
    if (!isRecord(migrated)) return null;
    const next = typeof migrated['schemaVersion'] === 'number' ? (migrated['schemaVersion'] as number) : version + 1;
    if (next <= version) return null; // a migrator MUST advance the version, else we'd loop forever
    current = migrated;
    version = next;
  }

  return normalizeSnapshot(current, agentId);
}

/** Coerce a (post-migration) blob into a fully-shaped snapshot, defaulting anything missing. */
function normalizeSnapshot(raw: Record<string, unknown>, agentId: string): AgentSnapshot {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    agentId: typeof raw['agentId'] === 'string' ? (raw['agentId'] as string) : agentId,
    savedAt: typeof raw['savedAt'] === 'number' ? (raw['savedAt'] as number) : 0,
    slots: isRecord(raw['slots']) ? (raw['slots'] as Record<string, unknown>) : {},
    layout: Array.isArray(raw['layout']) ? (raw['layout'] as PanelOverride[]) : [],
    widgets: isRecord(raw['widgets']) ? (raw['widgets'] as Record<string, unknown>) : {},
    transcript: raw['transcript'] ?? null,
  };
}

// -----------------------------------------------------------------------------
// Persistence index — the durable record of which agents are opted in.
// -----------------------------------------------------------------------------

/**
 * The opt-in registry, itself persisted so a cold start knows which agents to
 * rehydrate. `transcript` is the subset of `persistent` that ALSO opted into the
 * separate transcript persistence (§15).
 */
export interface PersistIndex {
  readonly persistent: readonly string[];
  readonly transcript: readonly string[];
}

export function serializeIndex(index: PersistIndex): string {
  return JSON.stringify(index);
}

/** Parse the index blob; any corruption yields an empty (all-session-scoped) index. */
export function parseIndex(serialized: string | null): PersistIndex {
  if (!serialized) return { persistent: [], transcript: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } catch {
    return { persistent: [], transcript: [] };
  }
  if (!isRecord(raw)) return { persistent: [], transcript: [] };
  return {
    persistent: toStringArray(raw['persistent']),
    transcript: toStringArray(raw['transcript']),
  };
}

// -----------------------------------------------------------------------------
// StorageBackend seam — localStorage now, on-device SQLite (P1-10) later.
// -----------------------------------------------------------------------------

/**
 * The pluggable storage seam. Deliberately async (Promise-returning) so the
 * eventual on-device SQLite store — reached over async Tauri IPC — drops in
 * behind the same interface WITHOUT touching a single caller. The localStorage
 * backend simply resolves immediately. Values are opaque strings (the caller
 * owns (de)serialisation via the helpers above).
 */
export interface StorageBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  /** Enumerate keys beginning with `prefix` (for sweeps / index rebuilds). */
  keys(prefix: string): Promise<string[]>;
}

// -----------------------------------------------------------------------------
// Small internal guards.
// -----------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}
