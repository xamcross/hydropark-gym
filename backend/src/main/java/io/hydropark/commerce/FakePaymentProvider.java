package io.hydropark.commerce;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.hydropark.common.Money;
import io.hydropark.common.Uuid7;
import io.hydropark.config.AppProperties;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/**
 * §7.1 - the credential-free provider used by docker-compose so the whole purchase flow is
 * exercisable without any Stripe keys. {@code createCheckout} returns a local URL; {@code
 * verifyWebhook} authenticates the raw body with an HMAC-SHA256 over a dev secret, constant-time,
 * before any parsing - mirroring exactly how the real provider is verified.
 *
 * <p>The signature header is {@code X-Hp-Signature: <hex(hmac_sha256(rawBody))>}. The body is a small
 * normalized JSON envelope (see {@code deploy} dev tooling), never provider-specific.
 *
 * <p><b>Dev auto-settle (bug A2 fix).</b> A real MoR fires its settlement webhook once a human pays
 * on the hosted checkout page; this fake provider has no hosted page and no human, so without help
 * nothing would ever call back and every fake order would sit {@code pending} forever - stranding the
 * client's {@code order_get} poll indefinitely ("Purchase pending..."). To simulate an instant
 * successful payment, {@link #createCheckout} also self-fires a correctly-signed settlement webhook
 * back to this <em>same process's</em> public {@code POST /v1/webhooks/mor} - asynchronously, shortly
 * after the checkout response is built, so the checkout call itself is never slowed or put at risk by
 * it. That webhook goes through the exact same public ingress (no secret, no verification there) and
 * the exact same {@link SettlementWorker} pipeline (HMAC verify over the raw bytes, dedupe, correlate,
 * amount check, transactional grant) as a genuine provider callback would - nothing is bypassed, only
 * the "a human clicks Pay" step is skipped. {@link StripePaymentProvider} carries none of this: a real
 * order only ever settles when Stripe itself calls back.
 */
@Component
@ConditionalOnProperty(name = "hydropark.payments.provider", havingValue = "fake", matchIfMissing = true)
public class FakePaymentProvider implements PaymentProvider {

  private static final Logger log = LoggerFactory.getLogger(FakePaymentProvider.class);
  private static final String SIGNATURE_HEADER = "x-hp-signature";

  /** Dev-only default so the flow works with zero configuration. Never used by the Stripe path. */
  private static final String DEFAULT_DEV_SECRET = "hydropark-dev-webhook-secret";

  /** The one real endpoint {@link WebhookController} exposes; loopback-only, same process. */
  private static final String WEBHOOK_PATH = "/v1/webhooks/mor";

  /**
   * Delay before the self-fired webhook goes out, so {@link #createCheckout}'s HTTP response to the
   * caller is always fully built and returned first - "checkout returns, THEN the order settles".
   */
  private static final long SELF_SETTLE_DELAY_MS = 250;

  private final AppProperties props;
  private final ObjectMapper mapper;
  private final byte[] secret;
  private final int serverPort;
  private final HttpClient http = HttpClient.newHttpClient();

  public FakePaymentProvider(
      AppProperties props, ObjectMapper mapper, @Value("${server.port:8080}") int serverPort) {
    this.props = props;
    this.mapper = mapper;
    this.serverPort = serverPort;
    String configured = props.getPayments().getStripeWebhookSecret();
    String s = (configured == null || configured.isBlank()) ? DEFAULT_DEV_SECRET : configured;
    this.secret = s.getBytes(StandardCharsets.UTF_8);
  }

  @Override
  public CheckoutSession createCheckout(Order order, String region) {
    // A local URL a dev tool / the client can hit to simulate the MoR-hosted page.
    String url =
        props.getPayments().getSuccessUrl()
            + "?order_id="
            + order.getId()
            + "&provider=fake&amount="
            + order.getAmount()
            + "&currency="
            + order.getCurrency();
    log.debug("fake checkout for order {} -> {}", order.getId(), url);
    selfSettleAsync(order, region);
    return new CheckoutSession(url);
  }

  /**
   * Bug A2 fix - builds + signs a {@code succeeded} event for {@code order}, then delivers it on a
   * virtual thread after {@link #SELF_SETTLE_DELAY_MS} so the checkout response always precedes it.
   * Delivery failures (e.g. the app not yet accepting connections) are logged and swallowed - dev
   * convenience only, never allowed to affect the checkout call that already returned.
   */
  private void selfSettleAsync(Order order, String region) {
    byte[] body = succeededEventBody(order, region);
    String signatureHex = HexFormat.of().formatHex(hmacSha256(body));
    Thread.ofVirtual()
        .start(
            () -> {
              try {
                Thread.sleep(SELF_SETTLE_DELAY_MS);
              } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
              }
              deliverWebhook(body, signatureHex);
            });
  }

  /**
   * The normalized JSON envelope {@link #verifyWebhook} parses (§ class javadoc): {@code event_id},
   * OUR {@code order_id} (the correlation anchor - never the provider's), a {@code succeeded} type,
   * the order's own server-derived {@code amount}/{@code currency} (so the settlement worker's
   * under-payment check always covers), and {@code buyer_country} equal to the checkout's own
   * {@code region} (so the N9 region cross-check never trips - this fake buyer never contradicts the
   * region it just claimed). No {@code card_fingerprint}/{@code risk_level}: an absent risk signal
   * settles immediately, exactly like a plain Stripe charge (see {@code AntiFraudService.isHighRisk}).
   * Package-private so a test can build the exact bytes a real self-fire would send.
   */
  byte[] succeededEventBody(Order order, String region) {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("event_id", Uuid7.generate());
    body.put("order_id", order.getId());
    body.put("provider_order_id", "fake_" + order.getId());
    body.put("type", "succeeded");
    body.put("amount", order.getAmount());
    body.put("currency", order.getCurrency());
    body.put("buyer_country", region);
    try {
      return mapper.writeValueAsBytes(body);
    } catch (Exception e) {
      throw new IllegalStateException("failed to build dev auto-settle webhook body", e);
    }
  }

  /**
   * POSTs the self-fired webhook to this same process's public endpoint - loopback only, never
   * crosses a real network boundary. Package-private (not {@code private}) so a test can override it
   * to capture the call instead of requiring a live HTTP server.
   */
  void deliverWebhook(byte[] rawBody, String signatureHex) {
    try {
      HttpRequest request =
          HttpRequest.newBuilder(URI.create("http://localhost:" + serverPort + WEBHOOK_PATH))
              .header("Content-Type", "application/json")
              .header("X-Hp-Signature", signatureHex)
              .POST(HttpRequest.BodyPublishers.ofByteArray(rawBody))
              .build();
      http.send(request, HttpResponse.BodyHandlers.discarding());
    } catch (Exception e) {
      // Dev convenience only - the checkout call already returned. A missed self-settle just leaves
      // the order pending; "Restore purchases" (entitlements_refresh) or a manual retry recovers it.
      log.warn("dev auto-settle webhook delivery failed (order stays pending): {}", e.getMessage());
    }
  }

  @Override
  public ProviderEvent verifyWebhook(Map<String, String> headers, byte[] rawBody) {
    String presented = header(headers, SIGNATURE_HEADER);
    if (presented == null || rawBody == null) {
      throw new WebhookVerificationException("missing fake webhook signature");
    }
    byte[] expected = hmacSha256(rawBody);
    byte[] provided;
    try {
      provided = HexFormat.of().parseHex(presented.trim());
    } catch (IllegalArgumentException e) {
      throw new WebhookVerificationException("malformed fake webhook signature");
    }
    // Constant-time; MessageDigest.isEqual does not early-return on length mismatch.
    if (!MessageDigest.isEqual(expected, provided)) {
      throw new WebhookVerificationException("fake webhook signature mismatch");
    }

    // Only NOW - after verification - do we parse.
    JsonNode n;
    try {
      n = mapper.readTree(rawBody);
    } catch (Exception e) {
      throw new WebhookVerificationException("unparseable fake webhook body", e);
    }
    String rawType = text(n, "type");
    String type = normalize(rawType);
    Money amount = null;
    if (n.hasNonNull("amount") && n.hasNonNull("currency")) {
      amount = new Money(n.get("amount").asLong(), n.get("currency").asText());
    }
    return new ProviderEvent(
        text(n, "event_id"),
        text(n, "order_id"),
        text(n, "provider_order_id"),
        type,
        amount,
        text(n, "buyer_country"),
        // SF10 signals: the dev envelope surfaces them explicitly so the whole per-instrument
        // velocity + hold-grant-until-clear flow is exercisable without any Stripe keys.
        text(n, "card_fingerprint"),
        text(n, "risk_level"));
  }

  private static String normalize(String rawType) {
    if (rawType == null) {
      return IGNORED;
    }
    return switch (rawType) {
      case "succeeded", "payment.succeeded" -> SUCCEEDED;
      case "refunded", "payment.refunded" -> REFUNDED;
      case "chargeback", "dispute", "chargeback.created" -> CHARGEBACK;
      case "cleared", "review.approved", "payment.cleared" -> CLEARED;
      default -> IGNORED; // subscription.* and anything unknown
    };
  }

  private byte[] hmacSha256(byte[] body) {
    try {
      Mac mac = Mac.getInstance("HmacSHA256");
      mac.init(new SecretKeySpec(secret, "HmacSHA256"));
      return mac.doFinal(body);
    } catch (Exception e) {
      throw new WebhookVerificationException("HMAC unavailable", e);
    }
  }

  private static String header(Map<String, String> headers, String lowerName) {
    if (headers == null) {
      return null;
    }
    String v = headers.get(lowerName);
    if (v != null) {
      return v;
    }
    for (Map.Entry<String, String> e : headers.entrySet()) {
      if (e.getKey() != null && e.getKey().equalsIgnoreCase(lowerName)) {
        return e.getValue();
      }
    }
    return null;
  }

  private static String text(JsonNode n, String field) {
    return n.hasNonNull(field) ? n.get(field).asText() : null;
  }
}
