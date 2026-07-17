/* Public surface of the persistence module (P1-06.8 · SPEC §9.9, §15). */

export {
  PERSISTENCE_NS,
  SNAPSHOT_SCHEMA_VERSION,
  SNAPSHOT_MIGRATIONS,
  emptySnapshot,
  collectSnapshot,
  applySnapshot,
  layoutSource,
  snapshotKey,
  snapshotKeyPrefix,
  indexKey,
  serializeSnapshot,
  parseSnapshot,
  migrateSnapshot,
  serializeIndex,
  parseIndex,
} from './persistence.model';
export type {
  AgentSnapshot,
  SnapshotContribution,
  SnapshotSource,
  CaptureContext,
  LayoutPersistencePort,
  SnapshotMigrator,
  PersistIndex,
  StorageBackend,
} from './persistence.model';

export { STORAGE_BACKEND, createDefaultStorageBackend, LocalStorageBackend, InMemoryStorageBackend } from './storage-backend';
export { SqliteStorageBackend } from './sqlite-storage.backend';

export { PersistenceService } from './persistence.service';
