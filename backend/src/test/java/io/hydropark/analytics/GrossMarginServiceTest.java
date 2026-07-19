package io.hydropark.analytics;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

import io.hydropark.analytics.GrossMarginService.GrossMarginInputs;
import io.hydropark.analytics.GrossMarginService.GrossMarginResult;
import org.junit.jupiter.api.Test;

/**
 * P1-25.3 - the hard kill metric. Verifies the gross-margin-per-install arithmetic (net sale minus CDN
 * egress cost, per install) and that the {@link GrossMarginService.MarginGate} BLOCKS at margin ≤ 0.
 */
class GrossMarginServiceTest {

  private final GrossMarginService service = new GrossMarginService();

  private static final long FIVE_GB = 5_000_000_000L;
  private static final long SIX_GB = 6_000_000_000L;
  private static final long FOUR_GB = 4_000_000_000L;

  @Test
  void positiveMarginPermitsScaling() {
    // gross 100000, 100 orders, fee = 100000*0.029 + 100*30 = 5900 -> net 94100.
    // egress 10 GB @ 1000 minor/GB -> CDN cost 10000. margin total 84100 / 100 installs = 841.
    GrossMarginResult r =
        service.evaluate(
            new GrossMarginInputs(
                100, 100_000, 100, SIX_GB, FOUR_GB, new MoRFeeModel(0.029, 30), 1000));

    assertThat(r.morFeeMinor()).isCloseTo(5900.0, within(1e-6));
    assertThat(r.netSalesMinor()).isCloseTo(94_100.0, within(1e-6));
    assertThat(r.cdnEgressBytes()).isEqualTo(10_000_000_000L);
    assertThat(r.cdnCostMinor()).isCloseTo(10_000.0, within(1e-6));
    assertThat(r.marginPerInstallMinor()).isCloseTo(841.0, within(1e-6));
    assertThat(r.gate().permitted()).isTrue();
    assertThat(r.gate().rationale()).contains("permitted");
  }

  @Test
  void zeroMarginIsBlocked() {
    // No MoR fee: net == gross == 5000. Egress 5 GB @ 1000/GB -> CDN cost 5000. margin total 0.
    GrossMarginResult r =
        service.evaluate(new GrossMarginInputs(1, 5_000, 0, FIVE_GB, 0, MoRFeeModel.none(), 1000));

    assertThat(r.marginPerInstallMinor()).isCloseTo(0.0, within(1e-9));
    assertThat(r.gate().permitted()).as("margin == 0 must block (strictly positive required)").isFalse();
    assertThat(r.gate().rationale()).contains("BLOCKED");
  }

  @Test
  void negativeMarginIsBlocked() {
    // gross 1000, 10 orders, fee = 29 + 300 = 329 -> net 671. Egress 10 GB @ 1000 -> cost 10000.
    // margin total 671 - 10000 = -9329 over 1 install.
    GrossMarginResult r =
        service.evaluate(
            new GrossMarginInputs(1, 1_000, 10, SIX_GB, FOUR_GB, new MoRFeeModel(0.029, 30), 1000));

    assertThat(r.marginPerInstallMinor()).isCloseTo(-9329.0, within(1e-6));
    assertThat(r.gate().permitted()).isFalse();
  }

  @Test
  void zeroInstallsIsBlockedAsUndefined() {
    GrossMarginResult r =
        service.evaluate(new GrossMarginInputs(0, 50_000, 5, 0, 0, MoRFeeModel.none(), 1000));

    assertThat(r.gate().permitted()).isFalse();
    assertThat(r.gate().rationale()).contains("no installs");
  }
}
