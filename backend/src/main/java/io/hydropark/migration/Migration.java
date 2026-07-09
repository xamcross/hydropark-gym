package io.hydropark.migration;

import org.springframework.data.mongodb.core.MongoTemplate;

/**
 * A single, ordered, run-once schema changeset.
 *
 * <p>MongoDB is schemaless, which is exactly why this exists: nothing forces an index or a document
 * shape into being, so index creation and backfills have to be explicit, versioned artifacts rather
 * than something a developer once typed into a shell. Several correctness properties in
 * BACKEND-DESIGN are <em>enforced by an index</em> and by nothing else - the unique partial index on
 * {@code skill_versions(skill_id) WHERE is_current}, the one-live-license-per-(skill,device) index,
 * and the {@code webhook_events.provider_event_id} uniqueness that makes webhook dedupe work. If
 * those indexes are missing, the code silently loses its guarantees instead of failing loudly.
 *
 * <p>Implementations must be idempotent: a changeset may be re-applied after a crash between the
 * write and the ledger entry.
 */
public interface Migration {

  /**
   * Monotonic, zero-padded, unique. Determines execution order. Never renumber a released
   * migration - the id is what the ledger remembers.
   */
  String id();

  String description();

  void apply(MongoTemplate mongo);
}
