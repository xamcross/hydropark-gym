package io.hydropark.common;

/**
 * Money is always minor units + ISO-4217 code (BACKEND-DESIGN §11). Never a float, never a
 * BigDecimal on the wire.
 */
public record Money(long amount, String currency) {

  public Money {
    if (currency == null || currency.length() != 3) {
      throw ApiException.validation("currency must be an ISO-4217 alpha-3 code");
    }
    currency = currency.toUpperCase();
  }

  public static Money of(long amount, String currency) {
    return new Money(amount, currency);
  }

  public boolean sameCurrencyAs(Money other) {
    return currency.equals(other.currency);
  }

  /**
   * §5.5.5 - a webhook must report at least the order's amount in the order's currency before it
   * settles. Under-payment never settles.
   */
  public boolean covers(Money required) {
    return sameCurrencyAs(required) && amount >= required.amount;
  }
}
