package io.hydropark.commerce;

import io.hydropark.common.ApiException;
import io.hydropark.common.ErrorCode;
import io.hydropark.common.Money;
import io.hydropark.config.AppProperties;
import io.hydropark.port.Ports.PurchaseKind;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
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
 *   <li><b>Per-account velocity limit:</b> purchases/day per user
 *       ({@code hydropark.payments.max-purchases-per-user-per-day}).
 *   <li><b>Per-instrument velocity limit:</b> distinct accounts/day a single card fingerprint may
 *       settle across ({@code hydropark.payments.max-accounts-per-fingerprint-per-day}), so one
 *       instrument cannot farm many accounts. Enforced at settlement, where the fingerprint arrives
 *       (see {@link #isPaymentFingerprintOverVelocity}).
 *   <li><b>Hold-grant-until-clear:</b> a risk-scored-high order settles as paid but its grant is
 *       withheld until the provider clears the review (see {@link #isHighRisk} and
 *       {@code SettlementService.settleSkillOrBundleOnHold}/{@code clearHeldOrder}).
 * </ul>
 *
 * <p>The two settlement-time controls read only what the settlement worker already holds - the order
 * plus the signature-verified {@link PaymentProvider.ProviderEvent} - and drive the existing
 * settlement path; they add no new privileged write path.
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

  /**
   * SF10 per-instrument velocity: has this funding instrument already settled across the daily limit
   * of <em>other</em> accounts? Called by the settlement worker on a {@code succeeded} skill/bundle
   * event, where the card fingerprint first becomes known (a hosted checkout has no card at
   * order-creation time). The current account is excluded - its own repeat use is bounded by the
   * per-account velocity - so this measures fan-out of one card across farmed accounts.
   *
   * <p>Returns false when the provider surfaced no fingerprint (the fake dev reversal envelopes, or a
   * Stripe charge whose details were not expanded): absence of a signal is never a trip.
   */
  public boolean isPaymentFingerprintOverVelocity(String userId, String paymentFingerprint) {
    if (paymentFingerprint == null || paymentFingerprint.isBlank()) {
      return false;
    }
    Instant cutoff = Instant.now().minus(1, ChronoUnit.DAYS);
    Query q =
        Query.query(
            Criteria.where("paymentFingerprint")
                .is(paymentFingerprint)
                .and("createdAt")
                .gte(cutoff)
                .and("userId")
                .ne(userId));
    List<String> otherAccounts = mongo.findDistinct(q, "userId", Order.class, String.class);
    return otherAccounts.size() >= props.getPayments().getMaxAccountsPerFingerprintPerDay();
  }

  /**
   * SF10 hold-grant-until-clear: is this settlement risky enough to withhold the grant until the
   * provider clears it? A provider {@code highest} risk level always holds; an {@code elevated} level
   * holds only for an account with no clean settled payment history (an established buyer's one
   * elevated charge is not held). No signal / a normal level never holds - so with the fake provider
   * or a plain Stripe charge the grant is issued immediately, exactly as before.
   */
  public boolean isHighRisk(Order order, PaymentProvider.ProviderEvent event) {
    String risk = event.riskLevel();
    if (risk == null) {
      return false;
    }
    if (risk.equalsIgnoreCase("highest")) {
      return true;
    }
    if (risk.equalsIgnoreCase("elevated")) {
      return !settlementLog.hasCleanSettledPayment(order.getUserId());
    }
    return false;
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
