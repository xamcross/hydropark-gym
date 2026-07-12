package io.hydropark.analytics;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

import io.hydropark.analytics.AnalyticsRollupService.PaidOrderRow;
import io.hydropark.analytics.AnalyticsRollupService.RollupInputs;
import io.hydropark.analytics.AnalyticsRollupService.RollupResult;
import io.hydropark.port.Ports.PurchaseKind;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * P1-25.2 rollups are pure arithmetic over pre-fetched rows/counts - no Mongo. These tests pin the KPI
 * definitions (conversion from rows, basket, attach, refund rate, net ARPU after MoR fees) and the
 * zero-denominator guard.
 */
class AnalyticsRollupServiceTest {

  private final AnalyticsRollupService service = new AnalyticsRollupService();

  /** user-2 buys twice (a skill and a bundle); conversion counts DISTINCT payers, not orders. */
  private static RollupInputs sampleInputs() {
    List<PaidOrderRow> paid =
        List.of(
            new PaidOrderRow("user-1", PurchaseKind.SKILL, 500),
            new PaidOrderRow("user-2", PurchaseKind.SKILL, 500),
            new PaidOrderRow("user-2", PurchaseKind.BUNDLE, 1200));
    return new RollupInputs(
        /* userCount */ 10,
        paid,
        /* activePaidGrantCount */ 4,
        /* refundedOrderCount */ 1,
        /* chargebackOrderCount */ 1,
        /* retentionCohortSize */ 8,
        /* retainedD7 */ 4,
        /* retainedD30 */ 2,
        new MoRFeeModel(0.029, 30));
  }

  @Test
  void conversionCountsDistinctPayersOverUsers() {
    RollupResult r = service.rollup(sampleInputs());

    // 2 distinct payers (user-1, user-2) over 10 users.
    assertThat(r.payerCount()).isEqualTo(2);
    assertThat(r.freeToPaidConversion()).isCloseTo(0.20, within(1e-9));
  }

  @Test
  void computesRevenueBasketAttachAndSkillsPerPayer() {
    RollupResult r = service.rollup(sampleInputs());

    assertThat(r.paidOrderCount()).isEqualTo(3);
    assertThat(r.grossRevenueMinor()).isEqualTo(2200); // 500 + 500 + 1200
    assertThat(r.averageBasketSizeMinor()).isCloseTo(2200.0 / 3, within(1e-9));
    // 1 bundle order out of (2 skill + 1 bundle) catalog orders.
    assertThat(r.bundleAttachRate()).isCloseTo(1.0 / 3, within(1e-9));
    // 4 active paid grants over 2 payers.
    assertThat(r.skillsPerPayer()).isCloseTo(2.0, within(1e-9));
  }

  @Test
  void netArpuIsAfterMorFees() {
    RollupResult r = service.rollup(sampleInputs());

    // fee = 2200 * 0.029 + 3 orders * 30 = 63.8 + 90 = 153.8 ; net = 2046.2
    assertThat(r.netRevenueMinorAfterFees()).isCloseTo(2046.2, within(1e-6));
    // net ARPU per user = 2046.2 / 10
    assertThat(r.netArpuMinorPerUser()).isCloseTo(204.62, within(1e-6));
  }

  @Test
  void refundRateIsOverEveryOrderThatEverSettled() {
    RollupResult r = service.rollup(sampleInputs());

    // 1 refunded over (3 paid + 1 refunded + 1 charged_back) = 1/5
    assertThat(r.refundRate()).isCloseTo(0.20, within(1e-9));
  }

  @Test
  void retentionIsReturnersOverCohort() {
    RollupResult r = service.rollup(sampleInputs());

    assertThat(r.retentionD7()).isCloseTo(0.50, within(1e-9)); // 4 / 8
    assertThat(r.retentionD30()).isCloseTo(0.25, within(1e-9)); // 2 / 8
  }

  @Test
  void emptyPeriodYieldsZerosNeverNaN() {
    RollupResult r =
        service.rollup(new RollupInputs(0, List.of(), 0, 0, 0, 0, 0, 0, MoRFeeModel.none()));

    assertThat(r.freeToPaidConversion()).isZero();
    assertThat(r.skillsPerPayer()).isZero();
    assertThat(r.netArpuMinorPerUser()).isZero();
    assertThat(r.refundRate()).isZero();
    assertThat(r.bundleAttachRate()).isZero();
    assertThat(r.averageBasketSizeMinor()).isZero();
    assertThat(r.retentionD7()).isZero();
    assertThat(r.retentionD30()).isZero();
  }
}
