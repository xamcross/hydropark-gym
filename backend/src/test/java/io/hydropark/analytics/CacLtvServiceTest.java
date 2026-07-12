package io.hydropark.analytics;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

import io.hydropark.analytics.CacLtvService.CacLtvReport;
import io.hydropark.analytics.CacLtvService.ChannelEconomics;
import io.hydropark.analytics.CacLtvService.ChannelInputs;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * P1-25.4 - organic-only CAC/LTV. Verifies the LTV:CAC ratio math, the kill-channel decision at the
 * ≥3:1 target, that a zero-cost organic channel is never killed (and reports null, not Infinity), and
 * the blended roll-up.
 */
class CacLtvServiceTest {

  private static final double TARGET = 3.0;

  private final CacLtvService service = new CacLtvService();

  @Test
  void computesLtvToCacAndKeepsAHealthyChannel() {
    // 1000 installs, 50 payers, net 22750 (50 × $4.55), organic content cost 5000.
    ChannelEconomics c =
        service.evaluateChannel(new ChannelInputs("videos", 1000, 50, 22_750, 5_000), TARGET);

    assertThat(c.cacPerInstallMinor()).isCloseTo(5.0, within(1e-9)); // 5000 / 1000
    assertThat(c.ltvPerInstallMinor()).isCloseTo(22.75, within(1e-9)); // 22750 / 1000
    assertThat(c.ltvPerPayerMinor()).isCloseTo(455.0, within(1e-9)); // 22750 / 50
    assertThat(c.ltvToCacRatio()).isCloseTo(4.55, within(1e-9)); // 22750 / 5000
    assertThat(c.cacPaybackFactor()).isCloseTo(4.55, within(1e-9)); // 22.75 / 5.0
    assertThat(c.killChannel()).as("4.55:1 clears the 3:1 target").isFalse();
  }

  @Test
  void killsAChannelBelowTheTarget() {
    // LTV:CAC = 20000 / 10000 = 2.0, below the 3:1 target.
    ChannelEconomics c =
        service.evaluateChannel(new ChannelInputs("blog", 1000, 20, 20_000, 10_000), TARGET);

    assertThat(c.ltvToCacRatio()).isCloseTo(2.0, within(1e-9));
    assertThat(c.killChannel()).isTrue();
  }

  @Test
  void zeroCostOrganicChannelIsNeverKilledAndRatioIsNull() {
    ChannelEconomics c =
        service.evaluateChannel(new ChannelInputs("community", 500, 10, 1_000, 0), TARGET);

    assertThat(c.cacPerInstallMinor()).isZero();
    assertThat(c.ltvToCacRatio()).as("undefined, not Infinity").isNull();
    assertThat(c.cacPaybackFactor()).isNull();
    assertThat(c.killChannel()).isFalse();
  }

  @Test
  void blendsAcrossChannels() {
    CacLtvReport report =
        service.evaluate(
            List.of(
                new ChannelInputs("videos", 1000, 50, 22_750, 5_000),
                new ChannelInputs("blog", 1000, 20, 20_000, 10_000)),
            TARGET);

    assertThat(report.channels()).hasSize(2);
    assertThat(report.channels().get(0).killChannel()).isFalse();
    assertThat(report.channels().get(1).killChannel()).isTrue();

    // Blended: net 42750 / cost 15000 = 2.85 -> below target -> flagged.
    ChannelEconomics blended = report.blended();
    assertThat(blended.channel()).isEqualTo("blended");
    assertThat(blended.installs()).isEqualTo(2000);
    assertThat(blended.ltvToCacRatio()).isCloseTo(2.85, within(1e-9));
    assertThat(blended.killChannel()).isTrue();
  }
}
