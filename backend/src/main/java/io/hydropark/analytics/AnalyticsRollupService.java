package io.hydropark.analytics;

import io.hydropark.port.Ports.PurchaseKind;
import java.util.List;
import org.springframework.stereotype.Service;

/**
 * P1-25.2 - the business rollups (SPEC §25): free→paid conversion, skills-per-payer, net ARPU after
 * MoR fees, refund rate, bundle attach rate, average basket size, and retention D7/D30.
 *
 * <p><b>Pure by construction.</b> {@link #rollup(RollupInputs)} is a total function over the rows and
 * counts the caller has already fetched - it holds no {@code MongoTemplate} and no repositories - so
 * every metric is unit-testable without Mongo. The Mongo I/O that assembles {@link RollupInputs} lives
 * in {@link AnalyticsQueryService}; keeping the arithmetic here means the definition of each KPI is
 * pinned by a test, not buried in an aggregation pipeline.
 *
 * <p>Money is minor currency units. Exact sums stay {@code long}; ratios and per-capita figures are
 * {@code double} (they are inherently fractional). Every ratio is guarded against a zero denominator
 * ({@link #ratio}) so an empty period yields {@code 0.0}, never {@code NaN}/{@code Infinity}.
 */
@Service
public class AnalyticsRollupService {

  /**
   * One currently-{@code paid} skill/bundle order. Wallet top-ups are excluded by the caller: a top-up
   * is not a catalog sale, so it belongs to neither conversion nor basket size.
   */
  public record PaidOrderRow(String userId, PurchaseKind kind, long amountMinor) {}

  /**
   * Everything the rollup needs, pre-fetched. {@code paidOrders} are the currently-paid skill/bundle
   * orders; {@code activePaidGrantCount} is the count of active grants (paid ownership - free skills
   * are never granted), which is the skills-per-payer numerator; {@code refundedOrderCount}/
   * {@code chargebackOrderCount} are order counts in those terminal states; the retention triple is a
   * cohort and its D7/D30 returners.
   */
  public record RollupInputs(
      long userCount,
      List<PaidOrderRow> paidOrders,
      long activePaidGrantCount,
      long refundedOrderCount,
      long chargebackOrderCount,
      long retentionCohortSize,
      long retainedD7,
      long retainedD30,
      MoRFeeModel fees) {}

  public record RollupResult(
      long userCount,
      long payerCount,
      long paidOrderCount,
      long grossRevenueMinor,
      double netRevenueMinorAfterFees,
      double freeToPaidConversion,
      double skillsPerPayer,
      double netArpuMinorPerUser,
      double refundRate,
      double bundleAttachRate,
      double averageBasketSizeMinor,
      double retentionD7,
      double retentionD30) {}

  public RollupResult rollup(RollupInputs in) {
    List<PaidOrderRow> orders = in.paidOrders() == null ? List.of() : in.paidOrders();

    long payerCount = orders.stream().map(PaidOrderRow::userId).distinct().count();
    long paidOrderCount = orders.size();
    long grossRevenueMinor = orders.stream().mapToLong(PaidOrderRow::amountMinor).sum();
    long bundleOrders = orders.stream().filter(o -> o.kind() == PurchaseKind.BUNDLE).count();
    long skillOrders = orders.stream().filter(o -> o.kind() == PurchaseKind.SKILL).count();

    MoRFeeModel fees = in.fees() == null ? MoRFeeModel.none() : in.fees();
    double netRevenue = fees.netMinor(grossRevenueMinor, paidOrderCount);

    // Refund rate over every order that ever settled (paid + reversed). A refund/chargeback leaves the
    // paid set, so adding them back to the denominator avoids a shrinking-base illusion where reversing
    // every sale reads as a 0% refund rate.
    long everSettled = paidOrderCount + in.refundedOrderCount() + in.chargebackOrderCount();

    return new RollupResult(
        in.userCount(),
        payerCount,
        paidOrderCount,
        grossRevenueMinor,
        netRevenue,
        ratio(payerCount, in.userCount()),
        ratio(in.activePaidGrantCount(), payerCount),
        in.userCount() == 0 ? 0.0 : netRevenue / in.userCount(),
        ratio(in.refundedOrderCount(), everSettled),
        ratio(bundleOrders, skillOrders + bundleOrders),
        paidOrderCount == 0 ? 0.0 : (double) grossRevenueMinor / paidOrderCount,
        ratio(in.retainedD7(), in.retentionCohortSize()),
        ratio(in.retainedD30(), in.retentionCohortSize()));
  }

  /** Safe ratio: {@code 0.0} when the denominator is {@code 0}, never {@code NaN}/{@code Infinity}. */
  static double ratio(long numerator, long denominator) {
    return denominator == 0 ? 0.0 : (double) numerator / denominator;
  }
}
