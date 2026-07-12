package io.hydropark.analytics;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/**
 * The analytics cost model + go/no-go thresholds, under {@code hydropark.analytics.*} (P1-25.3/.4/.5).
 * These are the tunables the gross-margin gate, CAC/LTV attribution, and the Phase-1→2 gate read - the
 * cost of egress, the MoR fee split, the organic content cost, and the LTV:CAC target.
 *
 * <p>Binds via {@code @Component} for the same reason {@link io.hydropark.registry.RegistryProperties}
 * and {@link io.hydropark.download.BlobStoreProperties} do: the application enables config properties
 * explicitly ({@code @EnableConfigurationProperties}) rather than scanning, so a standalone
 * {@code @ConfigurationProperties} class registers itself as a component.
 *
 * <p><b>Cost defaults are deliberately 0, not fabricated</b> (mirroring {@code
 * BlobStoreProperties.modelBytesEstimate}). A real deployment supplies the true egress price
 * ({@code HP_ANALYTICS_COST_PER_GB_EGRESS_MINOR}) and the period's organic content spend
 * ({@code HP_ANALYTICS_CONTENT_COST_MINOR}) out of band. With both left 0 the margin gate reads "no
 * measured CDN cost", so an operator MUST set the real numbers before trusting the gate.
 */
@Component
@ConfigurationProperties(prefix = "hydropark.analytics")
public class AnalyticsProperties {

  /** MoR/Stripe percentage fee as a fraction (0.029 = 2.9%). §26.2. */
  private double morFeePercent = 0.029;

  /** MoR/Stripe fixed per-transaction fee, minor units (30 = $0.30). §26.2. */
  private long morFeeFixedMinor = 30;

  /**
   * CDN egress price, minor currency units per <b>decimal</b> GB (1e9 bytes) served. Default 0 = no
   * fabricated cost; set the real per-GB price in any deployed zone. Drives the P1-25.3 margin gate.
   */
  private long costPerGbEgressMinor = 0;

  /** The organic/content/production cost for the period, minor units - the numerator of organic CAC
   * (§27.2: there is no paid ad spend; "CAC" is content/production cost). Default 0 until entered. */
  private long contentCostMinor = 0;

  /** LTV:CAC go/no-go target (§25: ≥ 3:1). */
  private double ltvToCacTarget = 3.0;

  /** ISO-4217 currency the money figures in the reports are expressed in (informational). */
  private String reportingCurrency = "USD";

  /** The configured MoR fee model, as the pure value object the services compute with. */
  public MoRFeeModel feeModel() {
    return new MoRFeeModel(morFeePercent, morFeeFixedMinor);
  }

  public double getMorFeePercent() {
    return morFeePercent;
  }

  public void setMorFeePercent(double morFeePercent) {
    this.morFeePercent = morFeePercent;
  }

  public long getMorFeeFixedMinor() {
    return morFeeFixedMinor;
  }

  public void setMorFeeFixedMinor(long morFeeFixedMinor) {
    this.morFeeFixedMinor = morFeeFixedMinor;
  }

  public long getCostPerGbEgressMinor() {
    return costPerGbEgressMinor;
  }

  public void setCostPerGbEgressMinor(long costPerGbEgressMinor) {
    this.costPerGbEgressMinor = costPerGbEgressMinor;
  }

  public long getContentCostMinor() {
    return contentCostMinor;
  }

  public void setContentCostMinor(long contentCostMinor) {
    this.contentCostMinor = contentCostMinor;
  }

  public double getLtvToCacTarget() {
    return ltvToCacTarget;
  }

  public void setLtvToCacTarget(double ltvToCacTarget) {
    this.ltvToCacTarget = ltvToCacTarget;
  }

  public String getReportingCurrency() {
    return reportingCurrency;
  }

  public void setReportingCurrency(String reportingCurrency) {
    this.reportingCurrency = reportingCurrency;
  }
}
