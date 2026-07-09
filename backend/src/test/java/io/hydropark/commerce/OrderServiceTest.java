package io.hydropark.commerce;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import io.hydropark.commerce.PaymentProvider.CheckoutSession;
import io.hydropark.common.ApiException;
import io.hydropark.common.ErrorCode;
import io.hydropark.common.Money;
import io.hydropark.config.AppProperties;
import io.hydropark.port.Ports.PricingPort;
import io.hydropark.port.Ports.PurchaseKind;
import io.hydropark.port.Ports.SettlementPort;
import io.hydropark.port.Ports.WalletPort;
import io.hydropark.port.Ports.WalletPurchaseResult;
import java.lang.reflect.RecordComponent;
import java.util.Arrays;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.data.mongodb.core.MongoTemplate;

/**
 * The two server-price-integrity properties of the public order surface. Unit tests over mocks; NOT
 * run here (per the agent contract).
 */
@ExtendWith(MockitoExtension.class)
class OrderServiceTest {

  @Mock MongoTemplate mongo;
  @Mock PricingPort pricing;
  @Mock PaymentProvider provider;
  @Mock SettlementPort settlement;
  @Mock WalletPort wallet;
  @Mock AntiFraudService antiFraud;

  private OrderService service() {
    return new OrderService(
        mongo, pricing, provider, settlement, wallet, antiFraud, new AppProperties());
  }

  /** SF1 - a client-supplied {@code amount} is ignored for a skill; the server-derived price wins. */
  @Test
  void checkoutIgnoresClientAmountForSkill() {
    when(pricing.quote(PurchaseKind.SKILL, "skill-a", "US")).thenReturn(new Money(500, "USD"));
    when(provider.createCheckout(any(Order.class), eq("US")))
        .thenReturn(new CheckoutSession("http://checkout"));

    // Client tries to pay 1 minor unit for a skill.
    CheckoutRequest req = new CheckoutRequest("skill", "skill-a", "mor", 1L, null, "US");
    CheckoutResponse resp = service().checkout("user-1", false, req, null);

    ArgumentCaptor<Order> saved = ArgumentCaptor.forClass(Order.class);
    verify(mongo).insert(saved.capture());
    // The persisted order carries the SERVER price, not the client's 1.
    assertEquals(500, saved.getValue().getAmount());
    assertEquals("USD", saved.getValue().getCurrency());
    assertEquals("http://checkout", resp.checkoutUrl());
  }

  /**
   * §5.4 - pay-wallet forwards only {@code (user, kind, target, region)} + key and NEVER a price. The
   * request type structurally cannot carry one, and the forwarded call has no price argument.
   */
  @Test
  void payWalletNeverTransmitsAPrice() {
    // Derived here only for the fraud gate; discarded, never sent.
    when(pricing.quote(PurchaseKind.SKILL, "skill-a", "US")).thenReturn(new Money(500, "USD"));
    when(settlement.payWithWallet("user-1", PurchaseKind.SKILL, "skill-a", "US", "idem-1"))
        .thenReturn(new WalletPurchaseResult("order-9", List.of("skill-a")));

    PayWalletRequest req = new PayWalletRequest("skill", "skill-a", "US");
    WalletPurchaseResponse resp = service().payWallet("user-1", false, req, "idem-1");

    assertEquals("order-9", resp.orderId());
    verify(settlement).payWithWallet("user-1", PurchaseKind.SKILL, "skill-a", "US", "idem-1");

    // Structural guarantee: no price/amount field exists on the wire types the wallet path uses.
    assertFalse(componentNames(PayWalletRequest.class).contains("amount"));
    assertFalse(componentNames(PayWalletRequest.class).contains("price"));
    assertFalse(componentNames(InternalPayWalletRequest.class).contains("amount"));
    assertFalse(componentNames(InternalPayWalletRequest.class).contains("price"));
  }

  /**
   * §3.5 - a top-up whose currency differs from the wallet's fixed currency is rejected AT CHECKOUT,
   * before any {@code createCheckout} call. Rejecting at settlement would strand a captured payment.
   * We assert both the wire code and that the payment provider was never touched.
   */
  @Test
  void topupInWrongCurrencyIsRejectedBeforeAnyCheckout() {
    when(wallet.currencyOf("user-1")).thenReturn(Optional.of("USD"));

    TopupRequest req = new TopupRequest(5_000L, "EUR", "US");

    assertThatThrownBy(() -> service().topup("user-1", true, req, "idem-topup"))
        .isInstanceOf(ApiException.class)
        .extracting(e -> ((ApiException) e).errorCode())
        .isEqualTo(ErrorCode.WALLET_CURRENCY_MISMATCH);

    // No money may have moved: the checkout session was never created and no order was persisted.
    verify(provider, never()).createCheckout(any(Order.class), any());
    verify(mongo, never()).insert(any(Order.class));
  }

  /**
   * SF1's one exception - a {@code wallet_topup} order honours the client-supplied amount (there is
   * no catalog target to derive a price from), and the catalog price authority is never consulted for
   * it. Contrast {@link #checkoutIgnoresClientAmountForSkill}, where the client amount is discarded.
   */
  @Test
  void walletTopupHonoursClientAmountAndNeverQuotesPricing() {
    when(wallet.currencyOf("user-1")).thenReturn(Optional.empty()); // fresh wallet: request fixes currency
    when(provider.createCheckout(any(Order.class), eq("US")))
        .thenReturn(new CheckoutSession("http://checkout"));

    TopupRequest req = new TopupRequest(2_500L, "USD", "US");
    CheckoutResponse resp = service().topup("user-1", true, req, "idem-topup");

    ArgumentCaptor<Order> saved = ArgumentCaptor.forClass(Order.class);
    verify(mongo).insert(saved.capture());
    // The order carries EXACTLY the client's amount - not a server-derived price.
    assertEquals(2_500L, saved.getValue().getAmount());
    assertEquals("USD", saved.getValue().getCurrency());
    assertEquals(PurchaseKind.WALLET_TOPUP.wire(), saved.getValue().getKind());
    assertEquals("http://checkout", resp.checkoutUrl());

    // The catalog price authority throws for WALLET_TOPUP by design - it must never be called.
    verify(pricing, never()).quote(eq(PurchaseKind.WALLET_TOPUP), any(), any());
  }

  private static Set<String> componentNames(Class<?> record) {
    return Arrays.stream(record.getRecordComponents())
        .map(RecordComponent::getName)
        .collect(Collectors.toSet());
  }
}
