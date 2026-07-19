package io.hydropark.commerce;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import io.hydropark.commerce.PaymentProvider.ProviderEvent;
import io.hydropark.common.Money;
import io.hydropark.config.AppProperties;
import io.hydropark.port.Ports.PurchaseKind;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Query;

/**
 * The two settlement-time SF10 controls (P1-14.9). Unit tests over mocked ports; NOT run here (per
 * the agent contract). The per-instrument velocity and the risk-hold decision read only the order +
 * the signature-verified {@link ProviderEvent}, so they are provider-agnostic and testable in
 * isolation.
 */
@ExtendWith(MockitoExtension.class)
class AntiFraudServiceTest {

  @Mock MongoTemplate mongo;
  @Mock SettlementLogService settlementLog;

  // A real AppProperties -> maxAccountsPerFingerprintPerDay defaults to 3.
  private final AppProperties props = new AppProperties();

  private AntiFraudService service() {
    return new AntiFraudService(mongo, settlementLog, props);
  }

  private static Order skillOrder(String userId) {
    return new Order(
        "order-1",
        userId,
        PurchaseKind.SKILL,
        "skill-a",
        new Money(500, "USD"),
        PaymentSource.MOR,
        "stripe",
        "US",
        OrderStatus.PAID,
        Instant.now());
  }

  private static ProviderEvent succeeded(String fingerprint, String risk) {
    return new ProviderEvent(
        "evt-1", "order-1", "pi-1", PaymentProvider.SUCCEEDED, new Money(500, "USD"), "US",
        fingerprint, risk);
  }

  // --- per-instrument velocity ---------------------------------------------------------------

  /** SF10 - one instrument settled across the daily limit of DISTINCT OTHER accounts trips. */
  @Test
  void fingerprintVelocityTripsAcrossAccounts() {
    // Three other accounts already settled this card today; the limit is 3.
    when(mongo.findDistinct(any(Query.class), eq("userId"), eq(Order.class), eq(String.class)))
        .thenReturn(List.of("user-2", "user-3", "user-4"));

    assertTrue(service().isPaymentFingerprintOverVelocity("user-1", "fp-card"));
  }

  /** Below the distinct-account limit, the same card is allowed through. */
  @Test
  void fingerprintUnderLimitDoesNotTrip() {
    when(mongo.findDistinct(any(Query.class), eq("userId"), eq(Order.class), eq(String.class)))
        .thenReturn(List.of("user-2", "user-3"));

    assertFalse(service().isPaymentFingerprintOverVelocity("user-1", "fp-card"));
  }

  /** No instrument fingerprint (fake reversal envelope / unexpanded Stripe charge) is never a trip. */
  @Test
  void absentFingerprintNeverTripsAndIsNotQueried() {
    assertFalse(service().isPaymentFingerprintOverVelocity("user-1", null));
    assertFalse(service().isPaymentFingerprintOverVelocity("user-1", "   "));
    verify(mongo, never()).findDistinct(any(Query.class), eq("userId"), eq(Order.class), eq(String.class));
  }

  // --- risk hold ------------------------------------------------------------------------------

  /** The provider's {@code highest} risk always holds, regardless of account history. */
  @Test
  void highestRiskIsAlwaysHeld() {
    assertTrue(service().isHighRisk(skillOrder("user-1"), succeeded("fp", "highest")));
  }

  /** An {@code elevated} score holds for a brand-new account with no clean settled payment. */
  @Test
  void elevatedRiskHoldsOnlyForUnestablishedAccounts() {
    when(settlementLog.hasCleanSettledPayment("user-1")).thenReturn(false);

    assertTrue(service().isHighRisk(skillOrder("user-1"), succeeded("fp", "elevated")));
  }

  /** The same {@code elevated} score does NOT hold once the account has a clean settled payment. */
  @Test
  void elevatedRiskIsNotHeldForAnEstablishedAccount() {
    when(settlementLog.hasCleanSettledPayment("user-1")).thenReturn(true);

    assertFalse(service().isHighRisk(skillOrder("user-1"), succeeded("fp", "elevated")));
  }

  /** A normal or absent risk level never holds - the grant issues immediately, as before. */
  @Test
  void normalOrAbsentRiskIsNeverHeld() {
    assertFalse(service().isHighRisk(skillOrder("user-1"), succeeded("fp", "normal")));
    assertFalse(service().isHighRisk(skillOrder("user-1"), succeeded("fp", null)));
  }
}
