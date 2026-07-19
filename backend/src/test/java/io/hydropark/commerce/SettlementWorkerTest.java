package io.hydropark.commerce;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.mongodb.client.result.UpdateResult;
import io.hydropark.commerce.PaymentProvider.ProviderEvent;
import io.hydropark.common.Money;
import io.hydropark.port.Ports.PricingPort;
import io.hydropark.port.Ports.PurchaseKind;
import java.time.Instant;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentMatcher;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.core.query.UpdateDefinition;

/**
 * The webhook pipeline's exactly-once and under-payment guarantees. Unit tests over mocks; NOT run
 * here (per the agent contract).
 *
 * <p>The claim update (which sets {@code provider_event_id}) is distinguished from the terminal
 * status writes by whether the query filters on {@code providerEventId}.
 */
@ExtendWith(MockitoExtension.class)
class SettlementWorkerTest {

  @Mock MongoTemplate mongo;
  @Mock PaymentProvider provider;
  @Mock SettlementService settlement;
  @Mock PricingPort pricing;
  @Mock AntiFraudService antiFraud;

  SettlementWorker worker;

  // The claim step is the only webhook_events update whose query mentions providerEventId.
  //
  // Both matchers must tolerate a null argument. `argThat(...)` evaluates to null as the placeholder
  // for the actual argument, so the moment a second `when(mongo.updateFirst(argThat(...), ...))` is
  // registered, Mockito re-runs every previously-registered matcher for that method against that
  // null - and an unguarded getQueryObject() throws before any test body executes.
  private static final ArgumentMatcher<Query> CLAIM =
      q -> q != null && q.getQueryObject().containsKey("providerEventId");
  private static final ArgumentMatcher<Query> STATUS =
      q -> q != null && !q.getQueryObject().containsKey("providerEventId");

  @BeforeEach
  void setup() {
    worker = new SettlementWorker(mongo, provider, settlement, pricing, antiFraud, 50, 5, 300_000L);
  }

  private static WebhookEvent row() {
    return new WebhookEvent(
        "row-1", "fake", new byte[] {1, 2, 3}, Map.of("x-hp-signature", "deadbeef"), Instant.now());
  }

  private static Order skillOrder() {
    return new Order(
        "order-1",
        "user-1",
        PurchaseKind.SKILL,
        "skill-a",
        new Money(500, "USD"),
        PaymentSource.MOR,
        "fake",
        "US",
        OrderStatus.PENDING,
        Instant.now());
  }

  private static ProviderEvent succeeded(long amount) {
    return new ProviderEvent(
        "evt-1", "order-1", "pi-1", PaymentProvider.SUCCEEDED, new Money(amount, "USD"), "US");
  }

  private static ProviderEvent succeededWith(long amount, String fingerprint, String risk) {
    return new ProviderEvent(
        "evt-1", "order-1", "pi-1", PaymentProvider.SUCCEEDED, new Money(amount, "USD"), "US",
        fingerprint, risk);
  }

  private static ProviderEvent cleared() {
    return new ProviderEvent("evt-2", "order-1", "pi-1", PaymentProvider.CLEARED, null, "US");
  }

  /** B2/B6 - a redelivered event (duplicate provider_event_id) grants exactly zero extra times. */
  @Test
  void duplicateProviderEventIdGrantsExactlyOnce() {
    when(provider.verifyWebhook(any(), any())).thenReturn(succeeded(500));
    // Another webhook_events row already owns this provider_event_id -> the unique index rejects the
    // claim with a duplicate-key error.
    when(mongo.updateFirst(argThat(CLAIM), any(UpdateDefinition.class), eq(WebhookEvent.class)))
        .thenThrow(new DuplicateKeyException("provider_event_id"));
    when(mongo.updateFirst(argThat(STATUS), any(UpdateDefinition.class), eq(WebhookEvent.class)))
        .thenReturn(UpdateResult.acknowledged(1L, 1L, null));

    worker.processOne(row());

    // No settlement, and the dedupe short-circuits BEFORE we even correlate the order.
    verify(settlement, never()).settleSkillOrBundle(any(), any());
    verify(mongo, never()).findById(any(), eq(Order.class));
  }

  /** SF9 - an event whose amount does not cover the order never settles; it is parked for review. */
  @Test
  void underPaymentDoesNotSettle() {
    when(provider.verifyWebhook(any(), any())).thenReturn(succeeded(100)); // paid 100, order is 500
    when(mongo.updateFirst(argThat(CLAIM), any(UpdateDefinition.class), eq(WebhookEvent.class)))
        .thenReturn(UpdateResult.acknowledged(1L, 1L, null));
    when(mongo.findById("order-1", Order.class)).thenReturn(skillOrder());
    when(mongo.updateFirst(argThat(STATUS), any(UpdateDefinition.class), eq(WebhookEvent.class)))
        .thenReturn(UpdateResult.acknowledged(1L, 1L, null));

    worker.processOne(row());

    verify(settlement, never()).settleSkillOrBundle(any(), any());
  }

  /** The happy path settles exactly once when the amount covers and the region matches. */
  @Test
  void coveringPaymentSettlesOnce() {
    ProviderEvent ev = succeeded(500);
    Order order = skillOrder();
    when(provider.verifyWebhook(any(), any())).thenReturn(ev);
    when(mongo.updateFirst(argThat(CLAIM), any(UpdateDefinition.class), eq(WebhookEvent.class)))
        .thenReturn(UpdateResult.acknowledged(1L, 1L, null));
    when(mongo.findById("order-1", Order.class)).thenReturn(order);
    when(mongo.updateFirst(argThat(STATUS), any(UpdateDefinition.class), eq(WebhookEvent.class)))
        .thenReturn(UpdateResult.acknowledged(1L, 1L, null));

    worker.processOne(row());

    verify(settlement, times(1)).settleSkillOrBundle(order, ev);
  }

  /**
   * SF10 per-instrument velocity - a card fanned across too many accounts trips the fingerprint
   * limit; the event is parked (dead-lettered) and nothing settles or is held.
   */
  @Test
  void fingerprintVelocityTripParksAndNeverSettles() {
    when(provider.verifyWebhook(any(), any())).thenReturn(succeededWith(500, "fp-card", null));
    when(mongo.updateFirst(argThat(CLAIM), any(UpdateDefinition.class), eq(WebhookEvent.class)))
        .thenReturn(UpdateResult.acknowledged(1L, 1L, null));
    when(mongo.findById("order-1", Order.class)).thenReturn(skillOrder());
    when(mongo.updateFirst(argThat(STATUS), any(UpdateDefinition.class), eq(WebhookEvent.class)))
        .thenReturn(UpdateResult.acknowledged(1L, 1L, null));
    when(antiFraud.isPaymentFingerprintOverVelocity("user-1", "fp-card")).thenReturn(true);

    worker.processOne(row());

    verify(settlement, never()).settleSkillOrBundle(any(), any());
    verify(settlement, never()).settleSkillOrBundleOnHold(any(), any());
  }

  /**
   * SF10 hold-grant-until-clear - a high-risk succeeded settles on hold (paid, grant withheld), never
   * through the immediate grant path.
   */
  @Test
  void highRiskOrderIsHeldNotGrantedImmediately() {
    ProviderEvent ev = succeededWith(500, "fp-card", "highest");
    Order order = skillOrder();
    when(provider.verifyWebhook(any(), any())).thenReturn(ev);
    when(mongo.updateFirst(argThat(CLAIM), any(UpdateDefinition.class), eq(WebhookEvent.class)))
        .thenReturn(UpdateResult.acknowledged(1L, 1L, null));
    when(mongo.findById("order-1", Order.class)).thenReturn(order);
    when(mongo.updateFirst(argThat(STATUS), any(UpdateDefinition.class), eq(WebhookEvent.class)))
        .thenReturn(UpdateResult.acknowledged(1L, 1L, null));
    when(antiFraud.isHighRisk(order, ev)).thenReturn(true);

    worker.processOne(row());

    verify(settlement, times(1)).settleSkillOrBundleOnHold(order, ev);
    verify(settlement, never()).settleSkillOrBundle(any(), any());
  }

  /** SF10 release - a clear event drives {@code clearHeldOrder}, never a fresh immediate settlement. */
  @Test
  void clearedEventReleasesHeldOrder() {
    ProviderEvent ev = cleared();
    Order order = skillOrder();
    when(provider.verifyWebhook(any(), any())).thenReturn(ev);
    when(mongo.updateFirst(argThat(CLAIM), any(UpdateDefinition.class), eq(WebhookEvent.class)))
        .thenReturn(UpdateResult.acknowledged(1L, 1L, null));
    when(mongo.findById("order-1", Order.class)).thenReturn(order);
    when(mongo.updateFirst(argThat(STATUS), any(UpdateDefinition.class), eq(WebhookEvent.class)))
        .thenReturn(UpdateResult.acknowledged(1L, 1L, null));

    worker.processOne(row());

    verify(settlement, times(1)).clearHeldOrder(order);
    verify(settlement, never()).settleSkillOrBundle(any(), any());
  }
}
