package io.hydropark.commerce;

import com.stripe.Stripe;
import com.stripe.exception.EventDataObjectDeserializationException;
import com.stripe.exception.SignatureVerificationException;
import com.stripe.exception.StripeException;
import com.stripe.model.Charge;
import com.stripe.model.Dispute;
import com.stripe.model.Event;
import com.stripe.model.PaymentIntent;
import com.stripe.model.Review;
import com.stripe.model.StripeObject;
import com.stripe.model.checkout.Session;
import com.stripe.net.Webhook;
import com.stripe.param.checkout.SessionCreateParams;
import io.hydropark.common.ApiException;
import io.hydropark.common.ErrorCode;
import io.hydropark.common.Money;
import io.hydropark.config.AppProperties;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/**
 * §7 - real Stripe Checkout wiring. Selected by {@code hydropark.payments.provider=stripe}.
 *
 * <p>Checkout carries our {@code orders.id} in both {@code client_reference_id} and {@code metadata}
 * (and on the PaymentIntent metadata, so charge/dispute events can be correlated). Webhooks are
 * verified with {@link Webhook#constructEvent} over the <b>raw body</b> before any parsing.
 *
 * <p><b>Report note:</b> Stripe is a payment processor, not a Merchant-of-Record - it does not act as
 * seller of record for VAT/sales tax. §7 assumes an MoR (Paddle/Lemon Squeezy). This class satisfies
 * the owner's explicit choice of real Stripe wiring; the {@link PaymentProvider} contract stays MoR-
 * shaped so Paddle can replace it. Correlating {@code charge.refunded}/{@code charge.dispute.created}
 * relies on our order id being present in the object metadata; Stripe does not always propagate
 * PaymentIntent metadata to a Charge, so refund/dispute correlation is best-effort here.
 */
@Component
@ConditionalOnProperty(name = "hydropark.payments.provider", havingValue = "stripe")
public class StripePaymentProvider implements PaymentProvider {

  private static final Logger log = LoggerFactory.getLogger(StripePaymentProvider.class);
  private static final String STRIPE_SIGNATURE_HEADER = "stripe-signature";
  private static final String ORDER_ID_KEY = "order_id";

  private final AppProperties props;

  public StripePaymentProvider(AppProperties props) {
    this.props = props;
  }

  @Override
  public CheckoutSession createCheckout(Order order, String region) {
    Stripe.apiKey = props.getPayments().getStripeApiKey();

    SessionCreateParams params =
        SessionCreateParams.builder()
            .setMode(SessionCreateParams.Mode.PAYMENT)
            .setSuccessUrl(props.getPayments().getSuccessUrl())
            .setCancelUrl(props.getPayments().getCancelUrl())
            // B2: our id echoed back on every event.
            .setClientReferenceId(order.getId())
            .putMetadata(ORDER_ID_KEY, order.getId())
            .setPaymentIntentData(
                SessionCreateParams.PaymentIntentData.builder()
                    .putMetadata(ORDER_ID_KEY, order.getId())
                    .build())
            .addLineItem(
                SessionCreateParams.LineItem.builder()
                    .setQuantity(1L)
                    .setPriceData(
                        SessionCreateParams.LineItem.PriceData.builder()
                            .setCurrency(order.getCurrency().toLowerCase())
                            .setUnitAmount(order.getAmount())
                            .setProductData(
                                SessionCreateParams.LineItem.PriceData.ProductData.builder()
                                    .setName(productName(order))
                                    .build())
                            .build())
                    .build())
            .build();

    try {
      Session session = Session.create(params);
      return new CheckoutSession(session.getUrl());
    } catch (StripeException e) {
      log.error("stripe checkout creation failed for order {}", order.getId(), e);
      throw new ApiException(ErrorCode.INTERNAL_ERROR, "checkout creation failed");
    }
  }

  @Override
  public ProviderEvent verifyWebhook(Map<String, String> headers, byte[] rawBody) {
    String sig = header(headers, STRIPE_SIGNATURE_HEADER);
    if (sig == null || rawBody == null) {
      throw new WebhookVerificationException("missing stripe signature");
    }
    String payload = new String(rawBody, StandardCharsets.UTF_8);
    Event event;
    try {
      event = Webhook.constructEvent(payload, sig, props.getPayments().getStripeWebhookSecret());
    } catch (SignatureVerificationException e) {
      throw new WebhookVerificationException("stripe signature verification failed", e);
    }

    StripeObject obj = deserializeDataObject(event);
    String stripeType = event.getType();

    String type = IGNORED;
    String ourOrderId = null;
    String providerOrderId = null;
    Money amount = null;
    String country = null;

    switch (stripeType == null ? "" : stripeType) {
      case "checkout.session.completed" -> {
        type = SUCCEEDED;
        if (obj instanceof Session s) {
          ourOrderId = s.getClientReferenceId();
          if (ourOrderId == null) {
            ourOrderId = meta(s.getMetadata());
          }
          if (s.getAmountTotal() != null && s.getCurrency() != null) {
            amount = new Money(s.getAmountTotal(), s.getCurrency().toUpperCase());
          }
          providerOrderId = s.getPaymentIntent();
          if (s.getCustomerDetails() != null && s.getCustomerDetails().getAddress() != null) {
            country = s.getCustomerDetails().getAddress().getCountry();
          }
        }
      }
      case "payment_intent.succeeded" -> {
        type = SUCCEEDED;
        if (obj instanceof PaymentIntent pi) {
          ourOrderId = meta(pi.getMetadata());
          if (pi.getAmount() != null && pi.getCurrency() != null) {
            amount = new Money(pi.getAmount(), pi.getCurrency().toUpperCase());
          }
          providerOrderId = pi.getId();
        }
      }
      case "charge.refunded" -> {
        type = REFUNDED;
        if (obj instanceof Charge c) {
          ourOrderId = meta(c.getMetadata());
          if (c.getAmount() != null && c.getCurrency() != null) {
            amount = new Money(c.getAmount(), c.getCurrency().toUpperCase());
          }
          providerOrderId = c.getPaymentIntent();
        }
      }
      case "charge.dispute.created" -> {
        type = CHARGEBACK;
        if (obj instanceof Dispute d) {
          ourOrderId = meta(d.getMetadata());
          if (d.getAmount() != null && d.getCurrency() != null) {
            amount = new Money(d.getAmount(), d.getCurrency().toUpperCase());
          }
          providerOrderId = d.getCharge();
        }
      }
      case "review.closed" -> {
        // SF10 clear signal. A Radar review resolved: "approved" releases a held grant; any other
        // reason (refunded/disputed) is a no-op here - the matching refund/dispute event carries the
        // reversal. A Review has no metadata echo, so it correlates by the PaymentIntent id we stored
        // as mor_order_id at settlement (the worker's fallback); the settlement path never grants an
        // order it did not itself put on hold, so provider-id correlation here can only release.
        if (obj instanceof Review r) {
          if ("approved".equalsIgnoreCase(r.getReason())) {
            type = CLEARED;
            providerOrderId = r.getPaymentIntent();
          }
        }
      }
      default -> type = IGNORED; // subscription.* etc.
    }

    // SF10 instrument signals: pull the card fingerprint + Radar risk level off the settled charge
    // when the event exposes it (Stripe surfaces them on the Charge; expand latest_charge on the
    // webhook endpoint to populate them on session/payment_intent success). Null when unavailable.
    String paymentFingerprint = null;
    String riskLevel = null;
    Charge charge = chargeOf(obj);
    if (charge != null) {
      paymentFingerprint = cardFingerprint(charge);
      if (charge.getOutcome() != null) {
        riskLevel = charge.getOutcome().getRiskLevel();
      }
    }

    return new ProviderEvent(
        event.getId(), ourOrderId, providerOrderId, type, amount, country, paymentFingerprint,
        riskLevel);
  }

  /**
   * The settled {@link Charge} behind an event, following the standard expandable references
   * ({@code session -> payment_intent -> latest_charge}). Each {@code get*Object()} returns null when
   * the reference was not expanded on delivery, so this is best-effort and never throws.
   */
  private static Charge chargeOf(StripeObject obj) {
    if (obj instanceof Charge c) {
      return c;
    }
    if (obj instanceof PaymentIntent pi) {
      return pi.getLatestChargeObject();
    }
    if (obj instanceof Session s) {
      PaymentIntent pi = s.getPaymentIntentObject();
      return pi == null ? null : pi.getLatestChargeObject();
    }
    return null;
  }

  private static String cardFingerprint(Charge c) {
    Charge.PaymentMethodDetails d = c.getPaymentMethodDetails();
    if (d == null || d.getCard() == null) {
      return null;
    }
    return d.getCard().getFingerprint();
  }

  /**
   * Deserializes the event's data object, surviving an API-version skew between Stripe and the SDK.
   *
   * <p>Stripe stamps each event with the API version pinned on the <em>webhook endpoint</em> (or the
   * account default) - not the version this SDK was compiled against ({@code Stripe.API_VERSION},
   * currently {@code 2025-03-31.basil}). When they differ, {@code getObject()} returns
   * {@link java.util.Optional#empty()} rather than throwing.
   *
   * <p>That silent empty is the dangerous part. The signature has already verified, so the event is
   * genuine; we then lose the data object, lose our {@code client_reference_id}, and the settlement
   * worker parks the event as "carried no order correlation". If the account's API version ever
   * drifts from the SDK's, <b>every</b> webhook dead-letters and settlement stops - while the logs
   * blame correlation rather than the version skew that actually caused it.
   *
   * <p>So: fall back to {@code deserializeUnsafe()} (the SDK's sanctioned escape hatch for exactly
   * this case), and log loudly with both versions. If even that fails, throw a verification error
   * naming the skew, so the operator sees the real cause. The durable fix is operational - pin the
   * webhook endpoint's API version to {@code Stripe.API_VERSION} - and it is documented in
   * deploy/README.md.
   */
  private static StripeObject deserializeDataObject(Event event) {
    var deserializer = event.getDataObjectDeserializer();
    var direct = deserializer.getObject();
    if (direct.isPresent()) {
      return direct.get();
    }

    log.warn(
        "stripe event {} has api_version={} but this SDK pins {}; falling back to unsafe "
            + "deserialization. Pin the webhook endpoint's API version to remove this risk.",
        event.getId(),
        event.getApiVersion(),
        Stripe.API_VERSION);
    try {
      return deserializer.deserializeUnsafe();
    } catch (EventDataObjectDeserializationException e) {
      throw new WebhookVerificationException(
          "stripe api_version skew: event="
              + event.getApiVersion()
              + " sdk="
              + Stripe.API_VERSION
              + "; data object could not be deserialized",
          e);
    }
  }

  private static String productName(Order order) {
    String target = order.getTargetId();
    return target != null ? target : order.getKind();
  }

  private static String meta(Map<String, String> metadata) {
    return metadata == null ? null : metadata.get(ORDER_ID_KEY);
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
}
