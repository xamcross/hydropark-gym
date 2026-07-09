package io.hydropark.commerce;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.hydropark.common.Money;
import io.hydropark.config.AppProperties;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Map;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
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
 */
@Component
@ConditionalOnProperty(name = "hydropark.payments.provider", havingValue = "fake", matchIfMissing = true)
public class FakePaymentProvider implements PaymentProvider {

  private static final Logger log = LoggerFactory.getLogger(FakePaymentProvider.class);
  private static final String SIGNATURE_HEADER = "x-hp-signature";

  /** Dev-only default so the flow works with zero configuration. Never used by the Stripe path. */
  private static final String DEFAULT_DEV_SECRET = "hydropark-dev-webhook-secret";

  private final AppProperties props;
  private final ObjectMapper mapper;
  private final byte[] secret;

  public FakePaymentProvider(AppProperties props, ObjectMapper mapper) {
    this.props = props;
    this.mapper = mapper;
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
    return new CheckoutSession(url);
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
        text(n, "buyer_country"));
  }

  private static String normalize(String rawType) {
    if (rawType == null) {
      return IGNORED;
    }
    return switch (rawType) {
      case "succeeded", "payment.succeeded" -> SUCCEEDED;
      case "refunded", "payment.refunded" -> REFUNDED;
      case "chargeback", "dispute", "chargeback.created" -> CHARGEBACK;
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
