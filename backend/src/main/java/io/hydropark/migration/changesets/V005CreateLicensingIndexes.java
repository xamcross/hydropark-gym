package io.hydropark.migration.changesets;

import com.mongodb.client.model.Filters;
import com.mongodb.client.model.IndexOptions;
import com.mongodb.client.model.Indexes;
import io.hydropark.migration.Migration;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.stereotype.Component;

/**
 * Indexes for the licensing collections (BACKEND-DESIGN §3.3, SPEC §13.11): {@code grants},
 * {@code licenses}, {@code license_audit}.
 *
 * <p>{@code grants} is the one that is easy to get wrong by "fixing" it: ownership is modeled as
 * one row per order->skill, and a user CAN legitimately hold two active grants for the same skill
 * (bought standalone, and again inside a bundle). See the inline comment below - do not add a
 * unique index on {@code (user_id, skill_id)}; that would make the second purchase fail, or worse,
 * make refunding one grant look like it should delete the other.
 */
@Component
public class V005CreateLicensingIndexes implements Migration {

  @Override
  public String id() {
    return "V005__create_licensing_indexes";
  }

  @Override
  public String description() {
    return "grants unique (order_id, skill_id) + (user_id, skill_id, status) idx; "
        + "licenses unique partial active (user_id, skill_id, device_id); license_audit query idx";
  }

  @Override
  public void apply(MongoTemplate mongo) {
    // grants: idempotent grant per order line - re-processing the same order/webhook can never
    // create a duplicate grant for the same skill within that order.
    mongo.getCollection("grants")
        .createIndex(
            Indexes.ascending("order_id", "skill_id"),
            new IndexOptions().name("grants_order_id_skill_id_unique").unique(true));

    // DELIBERATELY NOT unique on (user_id, skill_id). SPEC §13.11 / AGENT-CONTRACT rule 5:
    // ownership is "grants, never a mutable row" - a user may hold a standalone grant AND a
    // bundle grant for the same skill at once (two orders, two rows). A unique index here would
    // reject the second purchase outright, and - worse - refunding one grant would look
    // indistinguishable from the user never having the other. Effective entitlement is derived
    // as "≥1 grant with status=active" (the effective_entitlements view, §3.3), not by a single
    // row's existence. This index only supports that read pattern; it enforces nothing unique.
    mongo.getCollection("grants")
        .createIndex(
            Indexes.ascending("user_id", "skill_id", "status"),
            new IndexOptions().name("grants_user_skill_status_idx"));

    // licenses: "one live license per (skill, device)" - a re-issue must supersede the prior
    // active row rather than create a second live one. Partial on status='active' so historical
    // superseded rows (kept for audit) never collide with the current one.
    mongo.getCollection("licenses")
        .createIndex(
            Indexes.ascending("user_id", "skill_id", "device_id"),
            new IndexOptions()
                .name("licenses_active_unique")
                .unique(true)
                .partialFilterExpression(Filters.eq("status", "active")));

    // Supporting query indexes (not correctness-bearing): "all licenses issued to this device"
    // (deauthorize-device flow) and "issuance history for this user+skill" (support/audit).
    mongo.getCollection("licenses")
        .createIndex(Indexes.ascending("device_id"), new IndexOptions().name("licenses_device_id_idx"));
    mongo.getCollection("licenses")
        .createIndex(
            Indexes.ascending("user_id", "skill_id"), new IndexOptions().name("licenses_user_skill_idx"));

    // license_audit: not part of the BACKEND-DESIGN §3 SQL reference model - it backs the "all
    // signs audited" line in §2's License Issuer row, a broader append-only log than `licenses`
    // (which only records successful issuances). Inferred shape: one row per sign attempt
    // (issued/denied/rate_limited/revoked) keyed by (user_id, skill_id). Index supports "recent
    // audit trail for this user+skill" queries; not unique - it is an append-only log.
    mongo.getCollection("license_audit")
        .createIndex(
            Indexes.ascending("user_id", "skill_id", "created_at"),
            new IndexOptions().name("license_audit_user_skill_created_idx"));
  }
}
