package io.hydropark.commerce;

/**
 * Lifecycle of a captured MoR webhook (§4.8, §9). The public edge inserts rows as {@code received};
 * the worker claims them ({@code processing}), then finishes as {@code processed} or, after repeated
 * failure / an unverifiable signature, {@code dead_lettered}.
 */
public enum WebhookEventStatus {
  RECEIVED("received"),
  PROCESSING("processing"),
  PROCESSED("processed"),
  DEAD_LETTERED("dead_lettered");

  private final String wire;

  WebhookEventStatus(String wire) {
    this.wire = wire;
  }

  public String wire() {
    return wire;
  }
}
