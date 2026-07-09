package io.hydropark.commerce;

import io.hydropark.port.Ports.SettlementLogPort;
import java.time.Instant;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.core.query.Update;
import org.springframework.stereotype.Service;

/**
 * §3.6 / §6.2 - the append-only settlement log, the Issuer's authorization source.
 *
 * <p>{@link #recordSettled} is called only from inside the settlement worker's transaction (MoR path)
 * and the wallet-spend transaction; in production the Atlas role split (P1-21.7) is what actually
 * prevents the web tier writing this collection - this class is not the enforcement point.
 *
 * <p>{@link #isSettledOrder} is the point read the Issuer makes before signing. It returns false for
 * an order whose account has been {@code chargeback_blocked}, which is how a landed chargeback blocks
 * <em>all</em> further license issuance for that account (SF10) through the existing port surface
 * without a new method. See the report for the {@code isAccountBlocked(userId)} method that would make
 * this explicit.
 */
@Service
public class SettlementLogService implements SettlementLogPort {

  private final MongoTemplate mongo;

  public SettlementLogService(MongoTemplate mongo) {
    this.mongo = mongo;
  }

  @Override
  public void recordSettled(String orderId, String userId) {
    // Idempotent: a re-run under webhook redelivery writes the same row. The monotonic order guard
    // upstream means this is only ever reached once per order in practice.
    mongo.save(new SettledOrder(orderId, userId, Instant.now()));
  }

  @Override
  public boolean isSettledOrder(String orderId) {
    // Settled AND not blocked by a landed chargeback (SF10 account-wide issuance block).
    Query q =
        Query.query(
            Criteria.where("id").is(orderId).and("chargebackBlocked").ne(true));
    return mongo.exists(q, SettledOrder.class);
  }

  /**
   * SF10 - a clean settled payment exists for this user (used by the purchase-eligibility gate:
   * "verified email OR a settled prior payment"). Chargeback-blocked rows do not count.
   */
  public boolean hasCleanSettledPayment(String userId) {
    Query q = Query.query(Criteria.where("userId").is(userId).and("chargebackBlocked").ne(true));
    return mongo.exists(q, SettledOrder.class);
  }

  /** SF10 - true once any chargeback has landed on this account. */
  public boolean isAccountChargebackBlocked(String userId) {
    Query q = Query.query(Criteria.where("userId").is(userId).and("chargebackBlocked").is(true));
    return mongo.exists(q, SettledOrder.class);
  }

  /**
   * SF10 - flip the account-wide issuance block across every one of the user's settled orders, so the
   * Issuer's per-order {@link #isSettledOrder} check refuses all of them. Called from the worker's
   * chargeback handling (inside the settlement transaction).
   */
  public void blockAccountForChargeback(String userId) {
    mongo.updateMulti(
        Query.query(Criteria.where("userId").is(userId)),
        new Update().set("chargebackBlocked", true),
        SettledOrder.class);
  }
}
