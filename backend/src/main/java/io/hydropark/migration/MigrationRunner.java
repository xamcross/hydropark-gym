package io.hydropark.migration;

import java.time.Duration;
import java.time.Instant;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;
import org.bson.Document;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.stereotype.Component;

/**
 * Applies pending {@link Migration}s exactly once, under a lock, recording each in
 * {@code schema_migrations}.
 *
 * <p>The lock matters because migrations run at container start and Fly.io will happily boot several
 * instances at once. Two processes racing to build the same unique index is mostly harmless; two
 * processes racing to run a data backfill is not. The lock is a single document whose {@code _id} is
 * a constant - acquiring it is an insert, so contention surfaces as a duplicate-key error rather
 * than a read-then-write race. It carries an expiry so a process killed mid-migration cannot
 * deadlock every future deploy.
 *
 * <p>On start we also assert that every id in the ledger still exists in code. A migration that was
 * applied to production and then deleted from the source tree means the running schema no longer has
 * a description anywhere - we fail loudly rather than pretend the database is understood.
 */
@Component
@ConditionalOnProperty(name = "hydropark.migration.enabled", havingValue = "true", matchIfMissing = true)
public class MigrationRunner {

  private static final Logger log = LoggerFactory.getLogger(MigrationRunner.class);

  static final String LEDGER = "schema_migrations";
  static final String LOCK = "schema_migrations_lock";
  private static final String LOCK_ID = "singleton";
  private static final Duration LOCK_TTL = Duration.ofMinutes(10);

  private final MongoTemplate mongo;
  private final List<Migration> migrations;

  public MigrationRunner(MongoTemplate mongo, List<Migration> migrations) {
    this.mongo = mongo;
    this.migrations = migrations.stream().sorted(Comparator.comparing(Migration::id)).toList();
    assertUniqueIds(this.migrations);
  }

  /** Runs pending migrations. Returns the number applied. */
  public int run() {
    assertNoOrphanedLedgerEntries();

    String owner = java.util.UUID.randomUUID().toString();
    if (!acquireLock(owner)) {
      log.info("another instance holds the migration lock; skipping");
      return 0;
    }
    try {
      Set<String> applied = appliedIds();
      int count = 0;
      for (Migration m : migrations) {
        if (applied.contains(m.id())) {
          continue;
        }
        long started = System.currentTimeMillis();
        log.info("applying migration {} - {}", m.id(), m.description());
        m.apply(mongo);
        long tookMs = System.currentTimeMillis() - started;

        mongo
            .getCollection(LEDGER)
            .insertOne(
                new Document("_id", m.id())
                    .append("description", m.description())
                    .append("appliedAt", Instant.now())
                    .append("executionMs", tookMs));
        log.info("applied migration {} in {} ms", m.id(), tookMs);
        count++;
      }
      if (count == 0) {
        log.info("schema up to date ({} migrations known)", migrations.size());
      }
      return count;
    } finally {
      releaseLock(owner);
    }
  }

  private Set<String> appliedIds() {
    return mongo.getCollection(LEDGER).find().map(d -> d.getString("_id")).into(new HashSet<>());
  }

  /**
   * A ledger entry with no corresponding {@link Migration} bean means someone deleted a migration
   * that already ran somewhere. Refuse to start rather than run against a schema whose history we
   * can no longer read.
   */
  private void assertNoOrphanedLedgerEntries() {
    Set<String> known = migrations.stream().map(Migration::id).collect(Collectors.toSet());
    List<String> orphans = appliedIds().stream().filter(id -> !known.contains(id)).sorted().toList();
    if (!orphans.isEmpty()) {
      throw new IllegalStateException(
          "schema_migrations contains ids with no Migration in code: "
              + orphans
              + ". A released migration was deleted or renamed. Restore it (it may be a no-op body) "
              + "so the applied history stays describable.");
    }
  }

  private static void assertUniqueIds(List<Migration> migrations) {
    Set<String> seen = new HashSet<>();
    for (Migration m : migrations) {
      if (!seen.add(m.id())) {
        throw new IllegalStateException("duplicate migration id: " + m.id());
      }
    }
  }

  private boolean acquireLock(String owner) {
    Instant now = Instant.now();

    // Reap a lock abandoned by a crashed process before trying to take it.
    mongo.remove(
        Query.query(Criteria.where("_id").is(LOCK_ID).and("expiresAt").lt(now)), LOCK);

    try {
      mongo
          .getCollection(LOCK)
          .insertOne(
              new Document("_id", LOCK_ID)
                  .append("owner", owner)
                  .append("acquiredAt", now)
                  .append("expiresAt", now.plus(LOCK_TTL)));
      return true;
    } catch (DuplicateKeyException | com.mongodb.MongoWriteException e) {
      return false;
    }
  }

  private void releaseLock(String owner) {
    mongo.remove(Query.query(Criteria.where("_id").is(LOCK_ID).and("owner").is(owner)), LOCK);
  }
}
