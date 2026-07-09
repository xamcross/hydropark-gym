package io.hydropark.commerce;

/**
 * The monotonic order state machine (BACKEND-DESIGN §3.3, B6).
 *
 * <pre>
 *   pending -> paid -> {refunded | charged_back}
 *   pending -> {refunded | charged_back}   (reversal arriving before paid; sticky)
 *   failed                                  (terminal)
 * </pre>
 *
 * <p>Terminal states never transition again. A refund/chargeback that lands <em>before</em>
 * {@code paid} moves the order straight to a terminal reversal so a late duplicate {@code succeeded}
 * can never re-grant. Persisted as the wire string, never the enum name.
 */
public enum OrderStatus {
  PENDING("pending"),
  PAID("paid"),
  FAILED("failed"),
  REFUNDED("refunded"),
  CHARGED_BACK("charged_back");

  private final String wire;

  OrderStatus(String wire) {
    this.wire = wire;
  }

  public String wire() {
    return wire;
  }

  public boolean isTerminal() {
    return this == FAILED || this == REFUNDED || this == CHARGED_BACK;
  }
}
