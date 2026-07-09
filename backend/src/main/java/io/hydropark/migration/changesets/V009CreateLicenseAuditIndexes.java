package io.hydropark.migration.changesets;

import com.mongodb.client.model.IndexOptions;
import com.mongodb.client.model.Indexes;
import io.hydropark.migration.Migration;
import org.bson.Document;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.stereotype.Component;

/**
 * Fix-forward for the licensing indexes that back the signer's rate limiter and the license list
 * endpoint (BACKEND-DESIGN §6.2 N12, §4.4).
 *
 * <p>V005 indexed {@code license_audit (user_id, skill_id, created_at)}. The {@code LicenseAudit}
 * entity has <b>none</b> of {@code user_id} or {@code created_at}: it stores {@code sub}, {@code
 * caller}, {@code at} (plus {@code license_id}, {@code kid}, {@code skill_id}, {@code device_id}). So
 * the two queries the {@code IssuanceRateLimiter} actually runs - the primary per-{@code sub} limit
 * filtering {@code (sub, caller, at)} and the global backstop filtering {@code (at)} - matched
 * <b>no index at all</b> and degraded into a collection scan over an append-only log that grows
 * without bound. The per-{@code sub} limit is the primary abuse control (§6.2 N12); it must never be
 * a scan.
 *
 * <p>The V005 index is <b>not</b> correctness-harmful - it is non-unique, so it rejects no write -
 * but because it is keyed on fields no document ever carries ({@code user_id}/{@code created_at}
 * index as {@code null} on every row) it serves zero query and still costs an index write on every
 * append and storage proportional to the log's unbounded size. It references fields the entity does
 * not have, so we drop it here (a fresh database briefly creates it in V005 and drops it here - the
 * accepted cost of never editing a released changeset; V004→V008 set the precedent).
 *
 * <p>Adds, all with explicit deterministic names ({@code createIndex} with the same name but a
 * different spec throws):
 *
 * <ul>
 *   <li>{@code license_audit (sub, caller, at)} - the per-{@code sub} rate-limit query's exact
 *       equality-equality-range prefix.
 *   <li>{@code license_audit (at)} - the global per-minute backstop query.
 *   <li>{@code licenses (user_id, _id)} - {@code GET /v1/licenses} filters {@code user_id} and sorts
 *       by {@code _id} (a UUIDv7, so id order is creation order) for cursor pagination; V005's
 *       {@code (user_id, skill_id)} index does not order {@code _id}, so it cannot serve that sort.
 * </ul>
 *
 * <p>V005 is left untouched: a released changeset is immutable, because the ledger records that it
 * ran and re-editing it would leave deployed databases silently disagreeing with the source tree.
 */
@Component
public class V009CreateLicenseAuditIndexes implements Migration {

  private static final String AUDIT = "license_audit";
  private static final String LICENSES = "licenses";

  /** The V005 index keyed on fields the entity never writes - dropped here. */
  private static final String V005_PHANTOM_AUDIT_INDEX = "license_audit_user_skill_created_idx";

  @Override
  public String id() {
    return "V009__create_license_audit_indexes";
  }

  @Override
  public String description() {
    return "license_audit (sub,caller,at)+(at) query idx matching the issuance rate limiter; "
        + "licenses (user_id,_id) for GET /v1/licenses cursor pagination; "
        + "drops the V005 phantom (user_id,skill_id,created_at) license_audit index";
  }

  @Override
  public void apply(MongoTemplate mongo) {
    var audit = mongo.getCollection(AUDIT);

    // Drop the V005 phantom index iff it is present (defensive, like V008): it is keyed on
    // user_id/created_at which LicenseAudit never writes, so it serves nothing and only costs
    // writes on an unbounded log.
    for (Document existing : audit.listIndexes()) {
      if (V005_PHANTOM_AUDIT_INDEX.equals(existing.getString("name"))) {
        audit.dropIndex(V005_PHANTOM_AUDIT_INDEX);
        break;
      }
    }

    // Primary abuse control (§6.2 N12): per-sub issuance count over the last hour. The limiter
    // filters sub= AND caller= (equality) AND at>= (range), so the key order (sub, caller, at)
    // puts the two equalities first and the range last - the shape the optimizer needs.
    audit.createIndex(
        Indexes.ascending("sub", "caller", "at"),
        new IndexOptions().name("license_audit_sub_caller_at_idx"));

    // Wide global backstop: total signs in the last minute. Filters at>= only.
    audit.createIndex(Indexes.ascending("at"), new IndexOptions().name("license_audit_at_idx"));

    // GET /v1/licenses: filter user_id, sort DESC on _id, cursor _id < after. (An optional
    // device_id filter still rides this index and filters residually, or falls to the V005
    // (device_id) index - the planner picks; neither ordering is correctness-bearing.)
    mongo
        .getCollection(LICENSES)
        .createIndex(
            Indexes.ascending("user_id", "_id"),
            new IndexOptions().name("licenses_user_id_id_idx"));
  }
}
