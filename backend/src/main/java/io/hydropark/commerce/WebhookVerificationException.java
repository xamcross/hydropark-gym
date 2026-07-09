package io.hydropark.commerce;

/**
 * Thrown by a {@link PaymentProvider} when a webhook's signature does not verify over the raw body.
 * An unverifiable event can never become verifiable on retry, so the worker dead-letters it (and, in
 * production, alerts - §7.3) rather than looping.
 */
public class WebhookVerificationException extends RuntimeException {

  public WebhookVerificationException(String message) {
    super(message);
  }

  public WebhookVerificationException(String message, Throwable cause) {
    super(message, cause);
  }
}
