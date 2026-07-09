package io.hydropark.devices;

import java.time.Instant;
import org.springframework.data.mongodb.core.FindAndModifyOptions;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.core.query.Update;
import org.springframework.stereotype.Component;

/**
 * Atomic operations on the per-user {@link DeviceSlotCounter} (BE §11.1, §3.4 B4).
 *
 * <p>This is the redesign of the Postgres {@code pg_advisory_xact_lock(user_id)} the design calls
 * out as "the one spot that needs a deliberate redesign". There is no lock; there is a single
 * conditional {@code findAndModify} whose filter <em>is</em> the cap. Two parallel registrations can
 * never both pass a stale count, because the {@code $inc} and the {@code $lt} bound are one atomic
 * document operation.
 */
@Component
public class DeviceSlotCounters {

  private final MongoTemplate mongo;

  public DeviceSlotCounters(MongoTemplate mongo) {
    this.mongo = mongo;
  }

  /**
   * Idempotently make sure the counter document exists so the conditional {@link #tryClaim} has a
   * document to match. {@code setOnInsert} only writes on creation, so calling this on every
   * register is safe and never resets a live count.
   */
  public void ensure(String userId) {
    Instant now = Instant.now();
    Update u =
        new Update()
            .setOnInsert("activeSlots", 0)
            .setOnInsert("lifetimeDevices", 0L)
            .setOnInsert("churnCount", 0)
            .setOnInsert("churnWindowStart", now)
            .setOnInsert("flaggedForReview", false)
            .setOnInsert("updatedAt", now);
    mongo.upsert(Query.query(Criteria.where("id").is(userId)), u, DeviceSlotCounter.class);
  }

  /**
   * Claim one slot iff the user is under {@code maxActiveSlots}. Returns the updated counter, or
   * {@code null} when the cap is already reached (the caller maps {@code null} to {@code
   * SLOT_LIMIT_REACHED}). {@link #ensure} must have run first, or a missing document also yields
   * {@code null}.
   */
  public DeviceSlotCounter tryClaim(String userId, int maxActiveSlots) {
    Query q = Query.query(Criteria.where("id").is(userId).and("activeSlots").lt(maxActiveSlots));
    Update u = new Update().inc("activeSlots", 1).set("updatedAt", Instant.now());
    return mongo.findAndModify(
        q, u, FindAndModifyOptions.options().returnNew(true), DeviceSlotCounter.class);
  }

  /**
   * Release one slot. Guarded by {@code activeSlots > 0} so a double-release (or a race with the
   * reconciler) can never drive the count negative.
   */
  public void release(String userId) {
    Query q = Query.query(Criteria.where("id").is(userId).and("activeSlots").gt(0));
    Update u = new Update().inc("activeSlots", -1).set("updatedAt", Instant.now());
    mongo.findAndModify(
        q, u, FindAndModifyOptions.options().returnNew(true), DeviceSlotCounter.class);
  }

  /** Bump the lifetime distinct-device count (only a genuinely new fingerprint calls this). */
  public void incLifetime(String userId) {
    mongo.updateFirst(
        Query.query(Criteria.where("id").is(userId)),
        new Update().inc("lifetimeDevices", 1),
        DeviceSlotCounter.class);
  }

  public DeviceSlotCounter get(String userId) {
    return mongo.findById(userId, DeviceSlotCounter.class);
  }
}
