package io.hydropark.commerce;

import io.hydropark.common.Money;
import java.util.Map;

/**
 * §7.1 - the swappable Merchant-of-Record abstraction. All provider interaction sits behind this so
 * the concrete MoR can be swapped without touching licensing.
 *
 * <p><b>Report note:</b> §7 names a real Merchant-of-Record (Paddle / Lemon Squeezy) as the seller
 * of record that owns VAT/sales-tax. Stripe is <em>not</em> an MoR - the owner explicitly chose real
 * Stripe Checkout wiring for now, so this interface stays deliberately MoR-shaped ({@code custom_data}
 * echo, raw-body signature verify) to let Paddle drop in later.
 *
 * <p>Verification is folded into parsing: {@link #verifyWebhook} checks the signature over the raw
 * bytes <em>before</em> any parsing and returns a normalized {@link ProviderEvent}, or throws
 * {@link WebhookVerificationException}. It is called <b>only in the settlement worker</b>, the sole
 * holder of the secret.
 */
public interface PaymentProvider {

  /** Normalized {@link ProviderEvent#type()} values. */
  String SUCCEEDED = "succeeded";

  String REFUNDED = "refunded";
  String CHARGEBACK = "chargeback";
  String IGNORED = "ignored";

  /** Creates a hosted checkout carrying our {@code order.id} as correlation data (B2). */
  CheckoutSession createCheckout(Order order, String region);

  /**
   * Verifies the signature over {@code rawBody} (constant-time, pre-parse) and returns the normalized
   * event. Throws {@link WebhookVerificationException} on a bad/absent signature.
   */
  ProviderEvent verifyWebhook(Map<String, String> headers, byte[] rawBody);

  /** What {@link #createCheckout} yields: the hosted URL to open in the system browser (§13.2). */
  record CheckoutSession(String checkoutUrl) {}

  /**
   * A provider-agnostic event. {@code amount} is null for events where it is irrelevant (some
   * reversals); {@code buyerCountry} is null when the provider did not report geo. {@code ourOrderId}
   * is our {@code orders.id}, recovered from {@code custom_data}/{@code metadata}.
   */
  record ProviderEvent(
      String providerEventId,
      String ourOrderId,
      String providerOrderId,
      String type,
      Money amount,
      String buyerCountry) {}
}
