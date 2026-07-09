package io.hydropark.commerce;

import io.hydropark.common.ApiException;
import io.hydropark.common.ErrorCode;
import io.hydropark.common.Money;
import io.hydropark.config.AppProperties;
import io.hydropark.port.Ports.PurchaseKind;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.stereotype.Service;

/**
 * §8 SF10 / P1-14.9 - the chargeback-farming defenses for email-optional, worldwide $5 goods.
 *
 * <ul>
 *   <li><b>Account block:</b> once any chargeback lands, no further purchases (and, via
 *       {@link SettlementLogService#isSettledOrder}, no further license issuance) are allowed.
 *   <li><b>Purchase-eligibility gate:</b> a repeated or high-value skill/bundle buy requires a
 *       verified email OR a settled prior payment.
 *   <li><b>Velocity limit:</b> per-user purchases/day
 *       ({@code hydropark.payments.max-purchases-per-user-per-day}).
 * </ul>
 *
 * <p><b>Report note:</b> two SF10 items are stubbed - the per-<em>payment-fingerprint</em> velocity
 * limit (the fake provider surfaces no card fingerprint; Stripe could) and hold-grant-until-clear for
 * risk-scored orders (we grant on settlement, which for the MoR path already means funds cleared).
 */
@Service
public class AntiFraudService {

  /**
   * High-value threshold in minor units. There is no config field for this, so it is a package
   * constant (noted in the report); ~$50 at 100 minor units/unit. Currency-agnostic by design - it
   * treats any currency's minor units alike, which is conservative (stricter) for weaker currencies.
   */
  static final long HIGH_VALUE_MINOR = 5_000L;

  private final MongoTemplate mongo;
  private final SettlementLogService settlementLog;
  private final AppProperties props;

  public AntiFraudService(
      MongoTemplate mongo, SettlementLogService settlementLog, AppProperties props) {
    this.mongo = mongo;
    this.settlementLog = settlementLog;
    this.props = props;
  }

  /**
   * Full gate for a request that carries the caller's verified-email status (the public edge). Throws
   * on rejection.
   */
  public void assertPurchaseAllowed(
      String userId, boolean emailVerified, PurchaseKind kind, Money price) {
    assertNotBlockedAndUnderVelocity(userId);

    // Eligibility gate applies only to licensable buys (skill/bundle); a top-up is itself the payment
    // that would establish a settled history, so gating it on prior settlement is circular.
    if (kind == PurchaseKind.WALLET_TOPUP) {
      return;
    }
    boolean repeated = priorOrderCount(userId) >= 1;
    boolean highValue = price != null && price.amount() >= HIGH_VALUE_MINOR;
    if ((repeated || highValue) && !emailVerified && !settlementLog.hasCleanSettledPayment(userId)) {
      throw new ApiException(
          ErrorCode.FORBIDDEN,
          "verify your email or complete an initial purchase before repeated or high-value buys");
    }
  }

  /**
   * The subset the settlement worker can enforce for a wallet spend: it never sees {@code
   * emailVerified} (the {@link io.hydropark.port.Ports.SettlementPort} signature carries no such
   * field), so it applies the account block + velocity limit only. The edge already ran the full
   * gate.
   */
  public void assertWorkerPurchaseAllowed(String userId) {
    assertNotBlockedAndUnderVelocity(userId);
  }

  private void assertNotBlockedAndUnderVelocity(String userId) {
    if (settlementLog.isAccountChargebackBlocked(userId)) {
      throw new ApiException(
          ErrorCode.FORBIDDEN, "account is blocked following a chargeback");
    }
    int limit = props.getPayments().getMaxPurchasesPerUserPerDay();
    if (ordersInLastDay(userId) >= limit) {
      throw new ApiException(ErrorCode.RATE_LIMITED, "daily purchase limit reached");
    }
  }

  private long priorOrderCount(String userId) {
    return mongo.count(Query.query(Criteria.where("userId").is(userId)), Order.class);
  }

  private long ordersInLastDay(String userId) {
    Instant cutoff = Instant.now().minus(1, ChronoUnit.DAYS);
    return mongo.count(
        Query.query(Criteria.where("userId").is(userId).and("createdAt").gte(cutoff)), Order.class);
  }
}
