package io.hydropark.licensing;

import io.hydropark.common.Uuid7;
import io.hydropark.port.Ports.GrantPort;
import io.hydropark.port.Ports.GrantSource;
import io.hydropark.port.Ports.GrantStatus;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import org.bson.Document;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.core.query.Update;
import org.springframework.stereotype.Service;

/**
 * The {@link GrantPort} - ownership modeled as grants, never a mutable entitlement row
 * (BACKEND-DESIGN §3.3, §13.11). Consumed by {@code commerce} (settlement worker) and {@code wallet}
 * (chargeback clawback). Every mutating method here runs inside the worker's {@code @Transactional}
 * call and joins that ambient Mongo session automatically - it never opens its own.
 */
@Service
public class GrantService implements GrantPort {

  private static final Logger log = LoggerFactory.getLogger(GrantService.class);

  private final MongoTemplate mongo;
  private final GrantRepository grants;

  public GrantService(MongoTemplate mongo, GrantRepository grants) {
    this.mongo = mongo;
    this.grants = grants;
  }

  /**
   * Idempotent per {@code (order_id, skill_id)}. We rely on the <b>unique index</b> + a duplicate-key
   * short-circuit, not a pre-read: under webhook redelivery a pre-read is racy, whereas the index is
   * the authority. {@code payment_source}/{@code price_minor} are denormalised from the order (which
   * the worker has just written in this same transaction) so the clawback walk needs no join.
   */
  @Override
  public void createGrants(
      String userId, String orderId, GrantSource source, List<String> skillIds) {
    if (skillIds == null || skillIds.isEmpty()) {
      return;
    }
    Document order = mongo.findById(orderId, Document.class, "orders");
    String paymentSource = order != null ? order.getString("payment_source") : "unknown";
    String currency = order != null ? order.getString("currency") : null;
    long amount = order != null && order.get("amount") != null ? ((Number) order.get("amount")).longValue() : 0L;

    int n = skillIds.size();
    long per = amount / n;
    long remainder = amount % n; // put the odd minor units on the first grant so the split is exact
    Instant now = Instant.now();

    for (int i = 0; i < n; i++) {
      long price = per + (i == 0 ? remainder : 0);
      Grant g =
          Grant.create(
              Uuid7.generate(),
              userId,
              skillIds.get(i),
              source,
              orderId,
              paymentSource,
              currency,
              price,
              now);
      try {
        mongo.insert(g);
      } catch (DuplicateKeyException dup) {
        // (order_id, skill_id) already granted - a redelivered webhook. Idempotent no-op.
        log.debug("grant already exists for order {} skill {}", orderId, skillIds.get(i));
      }
    }
  }

  /**
   * §5.5.3 - a reversal flips <b>only</b> the grants tied to that order, and only those still
   * {@code active} (so a terminal grant is never re-touched and a second reversal can't double-flip).
   * A skill still covered by another active grant - e.g. bought both standalone and in a bundle -
   * stays owned (B1).
   */
  @Override
  public void flipGrantsForOrder(String orderId, GrantStatus newStatus) {
    Query q =
        Query.query(
            Criteria.where("order_id").is(orderId).and("status").is(GrantStatus.ACTIVE.wire()));
    Update u =
        new Update().set("status", newStatus.wire()).set("revoked_at", Instant.now());
    mongo.updateMulti(q, u, Grant.class);
  }

  @Override
  public boolean hasActiveGrant(String userId, String skillId) {
    return grants.existsByUserIdAndSkillIdAndStatus(userId, skillId, GrantStatus.ACTIVE.wire());
  }

  /**
   * §5.5.5 N5 - the wallet-chargeback clawback walk. Two determinism rules, both load-bearing:
   *
   * <ol>
   *   <li><b>Only currently-active, wallet-funded grants</b> are considered (the query filters
   *       {@code payment_source='wallet'} + {@code status='active'}), skipping already-terminal ones
   *       - otherwise a second top-up chargeback would double-count the same grant.
   *   <li>When the next grant's price <b>straddles</b> the remaining clawback amount it is revoked
   *       <b>in full</b> - grants can't be partially revoked, and covering the reversed credit beats
   *       leaving a deficit.
   * </ol>
   *
   * Walks most-recent-first, returns the revoked grant ids, marks them {@code charged_back}.
   */
  @Override
  public List<String> revokeWalletGrantsMostRecentFirst(String userId, long amountMinorUnits) {
    List<Grant> candidates =
        grants.findByUserIdAndPaymentSourceAndStatusOrderByGrantedAtDescIdDesc(
            userId, "wallet", GrantStatus.ACTIVE.wire());

    List<String> revoked = new ArrayList<>();
    long remaining = amountMinorUnits;
    Instant now = Instant.now();

    for (Grant g : candidates) {
      if (remaining <= 0) {
        break;
      }
      // Revoke in full even when this grant straddles the remaining amount.
      Query q =
          Query.query(
              Criteria.where("_id").is(g.getId()).and("status").is(GrantStatus.ACTIVE.wire()));
      Update u =
          new Update().set("status", GrantStatus.CHARGED_BACK.wire()).set("revoked_at", now);
      mongo.updateFirst(q, u, Grant.class);
      revoked.add(g.getId());
      remaining -= g.getPriceMinor();
    }
    return revoked;
  }
}
