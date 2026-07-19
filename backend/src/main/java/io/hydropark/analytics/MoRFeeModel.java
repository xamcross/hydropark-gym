package io.hydropark.analytics;

/**
 * The configurable Merchant-of-Record fee model (SPEC §26.2): a percentage of gross plus a fixed
 * per-transaction fee (Stripe today ≈ 2.9% + $0.30, with Stripe Tax/FX trimming net further). A
 * <b>pure</b> value object - it holds no state and touches no datastore, so every service that needs
 * "net after MoR fees" derives it from the same tested arithmetic.
 *
 * <p>{@code percent} is a fraction in {@code [0,1]} (0.029 = 2.9%), never a whole-number percentage;
 * {@code fixedMinorPerOrder} is minor currency units (30 = $0.30). The percentage is applied to the
 * gross once; the fixed fee is charged once per settled order - which is exactly why bundles and
 * wallet top-ups repair the fixed-fee drag (fewer, larger charges - §26.1).
 */
public record MoRFeeModel(double percent, long fixedMinorPerOrder) {

  public MoRFeeModel {
    if (percent < 0) {
      throw new IllegalArgumentException("MoR fee percent must be a non-negative fraction");
    }
    if (fixedMinorPerOrder < 0) {
      throw new IllegalArgumentException("MoR fixed fee must be >= 0 minor units");
    }
  }

  /** A zero fee model (no MoR fees applied). Used as a safe fallback when none is configured. */
  public static MoRFeeModel none() {
    return new MoRFeeModel(0.0, 0L);
  }

  /** Total MoR fee (minor units) charged on {@code grossMinor} spread across {@code orderCount} orders. */
  public double feeMinor(long grossMinor, long orderCount) {
    long orders = Math.max(0L, orderCount);
    return grossMinor * percent + (double) fixedMinorPerOrder * orders;
  }

  /** Net proceeds (minor units) after the MoR fee: {@code gross - fee}. May be fractional. */
  public double netMinor(long grossMinor, long orderCount) {
    return grossMinor - feeMinor(grossMinor, orderCount);
  }
}
