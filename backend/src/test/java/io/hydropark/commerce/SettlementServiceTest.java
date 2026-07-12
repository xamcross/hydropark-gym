package io.hydropark.commerce;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.mongodb.client.result.UpdateResult;
import io.hydropark.commerce.PaymentProvider.ProviderEvent;
import io.hydropark.common.Money;
import io.hydropark.port.Ports.GrantPort;
import io.hydropark.port.Ports.GrantSource;
import io.hydropark.port.Ports.PricingPort;
import io.hydropark.port.Ports.PurchaseKind;
import io.hydropark.port.Ports.WalletPort;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.core.query.UpdateDefinition;

/**
 * Correctness properties of the transactional settlement core. These are unit tests over mocked
 * ports; they were written but NOT executed here (per the agent contract).
 */
@ExtendWith(MockitoExtension.class)
class SettlementServiceTest {

  @Mock MongoTemplate mongo;
  @Mock PricingPort pricing;
  @Mock GrantPort grants;
  @Mock WalletPort wallet;
  @Mock SettlementLogService settlementLog;
  @Mock AntiFraudService antiFraud;

  @InjectMocks SettlementService service;

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

  @Test
  void settlesAndGrantsExactlyOnceWhenOrderIsPending() {
    Order order = skillOrder();
    // Guarded flip pending -> paid matched one document.
    when(mongo.updateFirst(any(Query.class), any(UpdateDefinition.class), eq(Order.class)))
        .thenReturn(UpdateResult.acknowledged(1L, 1L, null));
    when(pricing.memberSkills(PurchaseKind.SKILL, "skill-a")).thenReturn(List.of("skill-a"));

    boolean settled = service.settleSkillOrBundle(order, succeeded(500));

    assertTrue(settled);
    verify(settlementLog, times(1)).recordSettled("order-1", "user-1");
    verify(grants, times(1))
        .createGrants("user-1", "order-1", GrantSource.STANDALONE, List.of("skill-a"));
  }

  /**
   * B6 - a refund arriving BEFORE paid moves the order straight to a terminal state (sticky). A late
   * duplicate {@code succeeded} then finds the guarded flip {pending -> paid} matching ZERO rows, so
   * it never grants.
   */
  @Test
  void lateSucceededAfterTerminalDoesNotGrant() {
    Order order = skillOrder();
    when(mongo.updateFirst(any(Query.class), any(UpdateDefinition.class), eq(Order.class)))
        .thenReturn(UpdateResult.acknowledged(0L, 0L, null)); // no pending row to flip

    boolean settled = service.settleSkillOrBundle(order, succeeded(500));

    assertFalse(settled);
    verify(settlementLog, never()).recordSettled(anyString(), anyString());
    verify(grants, never()).createGrants(anyString(), anyString(), any(), any());
  }

  /** §5.4 - the worker derives the price itself and debits THAT, never any client-supplied amount. */
  @Test
  void walletSpendDebitsWorkerDerivedPrice() {
    when(pricing.quote(PurchaseKind.SKILL, "skill-a", "US")).thenReturn(new Money(700, "USD"));
    when(pricing.memberSkills(PurchaseKind.SKILL, "skill-a")).thenReturn(List.of("skill-a"));

    service.payWithWallet("user-1", PurchaseKind.SKILL, "skill-a", "US", "idem-1");

    // Debit uses the price the worker derived (700), not any amount from the caller.
    verify(wallet).debitForOrder(eq("user-1"), anyString(), eq(new Money(700, "USD")), eq("idem-1"));
    verify(grants).createGrants(eq("user-1"), anyString(), eq(GrantSource.STANDALONE), eq(List.of("skill-a")));
    verify(settlementLog).recordSettled(anyString(), eq("user-1"));
  }

  /**
   * SF10 hold-grant-until-clear - a high-risk settlement flips the order to paid but writes NO
   * {@code settled_orders} row and creates NO grant, so the Issuer refuses offline issuance while
   * held. The grant is deferred to {@link #clearingAHeldOrderReleasesTheGrant}.
   */
  @Test
  void heldOrderSettlesPaidButProducesNoActiveGrant() {
    Order order = skillOrder();
    when(mongo.updateFirst(any(Query.class), any(UpdateDefinition.class), eq(Order.class)))
        .thenReturn(UpdateResult.acknowledged(1L, 1L, null)); // pending -> paid, grant_held=true

    boolean held = service.settleSkillOrBundleOnHold(order, succeeded(500));

    assertTrue(held);
    verify(settlementLog, never()).recordSettled(anyString(), anyString());
    verify(grants, never()).createGrants(anyString(), anyString(), any(), any());
  }

  /** SF10 - clearing a still-held order runs the same settlement-log + grant writes as a normal settle. */
  @Test
  void clearingAHeldOrderReleasesTheGrant() {
    Order order = skillOrder();
    // Guard {status: paid, grant_held: true} matched the single held order.
    when(mongo.updateFirst(any(Query.class), any(UpdateDefinition.class), eq(Order.class)))
        .thenReturn(UpdateResult.acknowledged(1L, 1L, null));
    when(pricing.memberSkills(PurchaseKind.SKILL, "skill-a")).thenReturn(List.of("skill-a"));

    boolean released = service.clearHeldOrder(order);

    assertTrue(released);
    verify(settlementLog, times(1)).recordSettled("order-1", "user-1");
    verify(grants, times(1))
        .createGrants("user-1", "order-1", GrantSource.STANDALONE, List.of("skill-a"));
  }

  /**
   * A clear whose guard matches nothing (never held, already cleared, or moved terminal by a
   * chargeback that landed first) grants nothing - the release is idempotent and cannot re-grant.
   */
  @Test
  void clearingAnUnheldOrderGrantsNothing() {
    Order order = skillOrder();
    when(mongo.updateFirst(any(Query.class), any(UpdateDefinition.class), eq(Order.class)))
        .thenReturn(UpdateResult.acknowledged(0L, 0L, null)); // guard matched zero rows

    boolean released = service.clearHeldOrder(order);

    assertFalse(released);
    verify(settlementLog, never()).recordSettled(anyString(), anyString());
    verify(grants, never()).createGrants(anyString(), anyString(), any(), any());
  }
}
