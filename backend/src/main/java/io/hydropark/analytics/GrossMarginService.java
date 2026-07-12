package io.hydropark.analytics;

import org.springframework.stereotype.Service;

/**
 * P1-25.3 - <b>gross-margin-per-install</b>, the hard kill metric (SPEC §26.2).
 *
 * <pre>
 *   gross-margin-per-install = (net sale − CDN cost) / installs
 *   net sale                 = gross sales − MoR fees
 *   CDN cost                 = (model-download egress + free re-download egress) bytes × cost-per-GB
 * </pre>
 *
 * <p>The free ~2 GB base-model download and free re-downloads are a <b>per-install</b> cost carried
 * largely by non-payers, so each install can lose money at the low end of the conversion band. The
 * {@link MarginGate} therefore blocks scaling acquisition through <b>any</b> channel - organic
 * included, since every install carries the same CDN cost regardless of how it was acquired (§27.2) -
 * until margin-per-install is proven strictly positive.
 *
 * <p><b>Pure by construction:</b> {@link #evaluate(GrossMarginInputs)} is a total function over
 * pre-fetched totals (the CDN bytes come from {@code cdn_egress} samples, summed by
 * {@link AnalyticsQueryService}) plus the configured cost model. No datastore, fully unit-testable.
 */
@Service
public class GrossMarginService {

  /** Decimal GB for billing math: CDN egress is priced per 1e9 bytes, not per 2^30. */
  static final long BYTES_PER_GB = 1_000_000_000L;

  public record GrossMarginInputs(
      long installCount,
      long grossSalesMinor,
      long settledOrderCount,
      long modelEgressBytes,
      long freeReDownloadEgressBytes,
      MoRFeeModel fees,
      long costPerGbEgressMinor) {}

  /**
   * The scale-acquisition decision. {@code permitted == false} is the kill: scaling acquisition through
   * ANY channel is blocked until gross-margin-per-install is strictly positive. Zero installs is also
   * blocked - margin-per-install is undefined, so it is not yet proven positive.
   */
  public record MarginGate(boolean permitted, double marginPerInstallMinor, String rationale) {

    static MarginGate from(double marginPerInstallMinor, long installCount) {
      if (installCount <= 0) {
        return new MarginGate(
            false,
            0.0,
            "no installs yet - gross-margin-per-install is undefined, so scaling acquisition is not permitted");
      }
      boolean permitted = marginPerInstallMinor > 0.0;
      String rationale =
          permitted
              ? "gross-margin-per-install is positive - scaling acquisition through any channel is permitted"
              : "gross-margin-per-install <= 0 - scaling acquisition through ANY channel (organic included) is BLOCKED until it is proven positive";
      return new MarginGate(permitted, marginPerInstallMinor, rationale);
    }
  }

  public record GrossMarginResult(
      long installCount,
      long grossSalesMinor,
      double morFeeMinor,
      double netSalesMinor,
      long cdnEgressBytes,
      double cdnCostMinor,
      double grossMarginTotalMinor,
      double marginPerInstallMinor,
      MarginGate gate) {}

  public GrossMarginResult evaluate(GrossMarginInputs in) {
    MoRFeeModel fees = in.fees() == null ? MoRFeeModel.none() : in.fees();
    double morFee = fees.feeMinor(in.grossSalesMinor(), in.settledOrderCount());
    double netSales = in.grossSalesMinor() - morFee;

    long cdnBytes = in.modelEgressBytes() + in.freeReDownloadEgressBytes();
    double cdnCost = (double) cdnBytes / BYTES_PER_GB * in.costPerGbEgressMinor();

    double marginTotal = netSales - cdnCost;
    double marginPerInstall = in.installCount() <= 0 ? 0.0 : marginTotal / in.installCount();

    return new GrossMarginResult(
        in.installCount(),
        in.grossSalesMinor(),
        morFee,
        netSales,
        cdnBytes,
        cdnCost,
        marginTotal,
        marginPerInstall,
        MarginGate.from(marginPerInstall, in.installCount()));
  }
}
