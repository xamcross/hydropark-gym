package io.hydropark.commerce;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.hydropark.commerce.PaymentProvider.CheckoutSession;
import io.hydropark.commerce.PaymentProvider.ProviderEvent;
import io.hydropark.common.Money;
import io.hydropark.config.AppProperties;
import io.hydropark.port.Ports.PurchaseKind;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.Test;

/**
 * Bug A2 - the fake dev provider was returning a checkout URL and then never settling: nothing ever
 * fired the settlement webhook, so a fake order sat {@code pending} forever and the client's {@code
 * order_get} poll ("Purchase pending...") never completed. These tests cover the fix over the
 * provider directly, with no live HTTP server and no Mongo. Unit tests over the class under test
 * directly; NOT run here (per the agent contract).
 */
class FakePaymentProviderTest {

  /** {@code FakePaymentProvider.DEFAULT_DEV_SECRET} - kept in sync manually (that constant is private). */
  private static final String SECRET = "hydropark-dev-webhook-secret";

  private static Order order() {
    return new Order(
        "order-1",
        "user-1",
        PurchaseKind.SKILL,
        "packing-list",
        new Money(500, "USD"),
        PaymentSource.MOR,
        "fake",
        "US",
        OrderStatus.PENDING,
        Instant.now());
  }

  private static FakePaymentProvider provider() {
    return new FakePaymentProvider(new AppProperties(), new ObjectMapper(), 8080);
  }

  private static String hmacHex(byte[] body) {
    try {
      Mac mac = Mac.getInstance("HmacSHA256");
      mac.init(new SecretKeySpec(SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
      return HexFormat.of().formatHex(mac.doFinal(body));
    } catch (Exception e) {
      throw new IllegalStateException(e);
    }
  }

  /**
   * The exact body {@code createCheckout} self-fires, fed straight back into {@code verifyWebhook}
   * (the same method the real settlement worker calls, HMAC-verified over the raw bytes exactly as
   * §7.3 requires) - proves the self-fired event is well-formed and normalizes to a SUCCEEDED event
   * whose amount COVERS the order and whose buyer_country matches the order's own region, so neither
   * the under-payment check nor the N9 region cross-check can ever park it, and no risk/fingerprint
   * signal means {@code AntiFraudService.isHighRisk}/{@code isPaymentFingerprintOverVelocity} both stay
   * false, so nothing holds the grant either. {@code SettlementWorkerTest.coveringPaymentSettlesOnce}
   * already proves a covering SUCCEEDED event drives {@code settleSkillOrBundle}; together the two
   * prove self-fire -> verify -> settle end to end without a live server.
   */
  @Test
  void succeededEventBodyVerifiesAndCoversTheOrder() {
    FakePaymentProvider provider = provider();
    Order order = order();
    byte[] body = provider.succeededEventBody(order, "US");
    String sigHex = hmacHex(body);

    ProviderEvent ev = provider.verifyWebhook(Map.of("x-hp-signature", sigHex), body);

    assertEquals(PaymentProvider.SUCCEEDED, ev.type());
    assertEquals(order.getId(), ev.ourOrderId(), "must correlate on OUR order id, never the provider's");
    assertNotNull(ev.providerEventId(), "no event id -> the worker dead-letters it (B2)");
    assertNotNull(ev.amount());
    assertEquals(order.getAmount(), ev.amount().amount());
    assertEquals(order.getCurrency(), ev.amount().currency());
    assertTrue(ev.amount().covers(order.money()), "must cover the order or settlement parks it (SF9)");
    assertEquals(order.getRegion(), ev.buyerCountry(), "must match order.region or N9 parks it");
    assertNull(ev.paymentFingerprint());
    assertNull(ev.riskLevel(), "no risk signal -> isHighRisk() is false -> the grant is never held");
  }

  /** A signature over a DIFFERENT body than the one delivered must never verify (no accidental replay). */
  @Test
  void aTamperedSelfFiredBodyFailsVerification() {
    FakePaymentProvider provider = provider();
    byte[] body = provider.succeededEventBody(order(), "US");
    String sigOverOriginal = hmacHex(body);
    byte[] tampered = new String(body, StandardCharsets.UTF_8).replace("500", "1").getBytes(StandardCharsets.UTF_8);

    org.junit.jupiter.api.Assertions.assertThrows(
        WebhookVerificationException.class,
        () -> provider.verifyWebhook(Map.of("x-hp-signature", sigOverOriginal), tampered));
  }

  /**
   * `createCheckout` must schedule exactly one self-fire per order, carrying a body/signature that
   * `verifyWebhook` accepts, WITHOUT slowing down or risking the checkout response itself (delivery is
   * captured via an overridden `deliverWebhook` - package-private for exactly this - never a real
   * socket, so this test needs no running server).
   */
  @Test
  void createCheckoutReturnsImmediatelyAndSelfFiresExactlyOneVerifiableSettlementWebhook()
      throws InterruptedException {
    List<byte[]> delivered = new CopyOnWriteArrayList<>();
    List<String> signatures = new CopyOnWriteArrayList<>();
    FakePaymentProvider provider =
        new FakePaymentProvider(new AppProperties(), new ObjectMapper(), 8080) {
          @Override
          void deliverWebhook(byte[] rawBody, String signatureHex) {
            delivered.add(rawBody);
            signatures.add(signatureHex);
          }
        };
    Order order = order();

    CheckoutSession session = provider.createCheckout(order, "US");
    assertNotNull(session.checkoutUrl(), "checkout must still return synchronously, unaffected by the self-fire");
    assertTrue(delivered.isEmpty(), "the self-fire is async - it must not have landed synchronously");

    // Deliberately async (virtual thread, short delay) - poll briefly for it, well under the
    // client's own poll cadence (purchase.service.ts starts at 900ms).
    long deadline = System.currentTimeMillis() + 2000;
    while (delivered.isEmpty() && System.currentTimeMillis() < deadline) {
      Thread.sleep(20);
    }

    assertEquals(1, delivered.size(), "exactly one self-fire per createCheckout call");
    ProviderEvent ev =
        provider.verifyWebhook(Map.of("x-hp-signature", signatures.get(0)), delivered.get(0));
    assertEquals(PaymentProvider.SUCCEEDED, ev.type());
    assertEquals(order.getId(), ev.ourOrderId());
    assertTrue(ev.amount().covers(order.money()));
  }
}
