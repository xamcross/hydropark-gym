package io.hydropark.commerce;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertNotNull;

import com.stripe.Stripe;
import io.hydropark.commerce.PaymentProvider.ProviderEvent;
import io.hydropark.config.AppProperties;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.HexFormat;
import java.util.Map;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * Exercises the Stripe webhook verification path with genuinely Stripe-signed payloads. No network,
 * no Stripe account: {@code Webhook.constructEvent} is Stripe's own code, and its signature scheme
 * ({@code t=<unix>,v1=hex(hmac_sha256(secret, "t.payload"))}) is reproduced here exactly.
 */
class StripeWebhookVerificationTest {

  private static final String SECRET = "whsec_test_secret_value";
  private static final String ORDER_ID = "019f0000-0000-7000-8000-000000000001";

  private StripePaymentProvider provider;

  @BeforeEach
  void setUp() {
    AppProperties props = new AppProperties();
    props.getPayments().setStripeWebhookSecret(SECRET);
    provider = new StripePaymentProvider(props);
  }

  /** A checkout.session.completed event stamped with the given api_version. */
  private static String eventJson(String eventId, String apiVersion, long amountTotal) {
    return ("{"
            + "\"id\":\"%s\",\"object\":\"event\",\"api_version\":\"%s\",\"created\":%d,"
            + "\"livemode\":false,\"pending_webhooks\":1,"
            + "\"request\":{\"id\":null,\"idempotency_key\":null},"
            + "\"type\":\"checkout.session.completed\","
            + "\"data\":{\"object\":{"
            + "\"id\":\"cs_test_123\",\"object\":\"checkout.session\","
            + "\"client_reference_id\":\"%s\",\"metadata\":{\"order_id\":\"%s\"},"
            + "\"amount_total\":%d,\"currency\":\"usd\",\"payment_intent\":\"pi_test_123\","
            + "\"status\":\"complete\",\"payment_status\":\"paid\","
            + "\"customer_details\":{\"address\":{\"country\":\"US\"}}"
            + "}}}")
        .formatted(
            eventId, apiVersion, Instant.now().getEpochSecond(), ORDER_ID, ORDER_ID, amountTotal);
  }

  private static String signature(String payload, String secret, long timestamp) {
    try {
      Mac mac = Mac.getInstance("HmacSHA256");
      mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
      byte[] sig = mac.doFinal((timestamp + "." + payload).getBytes(StandardCharsets.UTF_8));
      return "t=" + timestamp + ",v1=" + HexFormat.of().formatHex(sig);
    } catch (Exception e) {
      throw new IllegalStateException(e);
    }
  }

  private ProviderEvent verify(String payload, String sigHeader) {
    return provider.verifyWebhook(
        Map.of("stripe-signature", sigHeader), payload.getBytes(StandardCharsets.UTF_8));
  }

  @Test
  void aValidlySignedEventIsParsedAndCorrelatedToOurOrderId() {
    String payload = eventJson("evt_ok", Stripe.API_VERSION, 500);
    ProviderEvent e = verify(payload, signature(payload, SECRET, Instant.now().getEpochSecond()));

    assertEquals("evt_ok", e.providerEventId());
    assertEquals(ORDER_ID, e.ourOrderId(), "our orders.id must survive as the correlation anchor");
    assertEquals(500L, e.amount().amount());
    assertEquals("USD", e.amount().currency());
    assertEquals("US", e.buyerCountry());
  }

  /**
   * The regression this file exists for. Stripe stamps events with the API version pinned on the
   * webhook endpoint, not the one this SDK was compiled against. When they differ,
   * {@code getObject()} returns empty <em>without throwing</em> - the signature has already
   * verified, so the event is genuine, but the data object silently vanishes and with it our
   * {@code client_reference_id}. Left unhandled, every webhook dead-letters as "carried no order
   * correlation" and settlement halts while the logs blame the wrong thing.
   */
  @Test
  void anEventStampedWithAnOlderApiVersionStillYieldsOurOrderId() {
    String payload = eventJson("evt_skew", "2020-08-27", 500);
    ProviderEvent e = verify(payload, signature(payload, SECRET, Instant.now().getEpochSecond()));

    assertNotNull(e.ourOrderId(), "api_version skew must not silently drop the data object");
    assertEquals(ORDER_ID, e.ourOrderId());
    assertEquals(500L, e.amount().amount());
  }

  @Test
  void aTamperedPayloadFailsVerification() {
    String payload = eventJson("evt_tamper", Stripe.API_VERSION, 500);
    String sig = signature(payload, SECRET, Instant.now().getEpochSecond());
    String tampered = payload.replace("\"amount_total\":500", "\"amount_total\":1");

    assertThrows(WebhookVerificationException.class, () -> verify(tampered, sig));
  }

  @Test
  void aSignatureFromAnotherSecretFailsVerification() {
    String payload = eventJson("evt_wrongsecret", Stripe.API_VERSION, 500);
    String sig = signature(payload, "whsec_attacker_controlled", Instant.now().getEpochSecond());

    assertThrows(WebhookVerificationException.class, () -> verify(payload, sig));
  }

  /** Stripe's default tolerance is 300s and rejects only *old* timestamps, never future ones. */
  @Test
  void aStaleTimestampFailsVerificationEvenWithACorrectSignature() {
    String payload = eventJson("evt_stale", Stripe.API_VERSION, 500);
    String sig = signature(payload, SECRET, Instant.now().getEpochSecond() - 3600);

    assertThrows(WebhookVerificationException.class, () -> verify(payload, sig));
  }

  @Test
  void aMissingSignatureHeaderFailsVerification() {
    String payload = eventJson("evt_nosig", Stripe.API_VERSION, 500);
    assertThrows(
        WebhookVerificationException.class,
        () -> provider.verifyWebhook(Map.of(), payload.getBytes(StandardCharsets.UTF_8)));
  }

  /** Sanity: the signing scheme under test really is HMAC-SHA256 over "timestamp.payload". */
  @Test
  void theTestHarnessReproducesStripesSigningScheme() throws Exception {
    String payload = "{\"a\":1}";
    long ts = 1700000000L;
    Mac mac = Mac.getInstance("HmacSHA256");
    mac.init(new SecretKeySpec(SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
    byte[] expected = mac.doFinal((ts + "." + payload).getBytes(StandardCharsets.UTF_8));
    String header = signature(payload, SECRET, ts);
    byte[] actual = HexFormat.of().parseHex(header.substring(header.indexOf("v1=") + 3));
    org.junit.jupiter.api.Assertions.assertTrue(MessageDigest.isEqual(expected, actual));
  }
}
