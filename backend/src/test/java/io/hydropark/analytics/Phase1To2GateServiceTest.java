package io.hydropark.analytics;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

import io.hydropark.analytics.Phase1To2GateService.Phase1To2GateInputs;
import io.hydropark.analytics.Phase1To2GateService.Phase1To2GateResult;
import org.junit.jupiter.api.Test;

/**
 * P1-25.5 - the Phase-1→2 go/no-go gate. BOTH conditions must hold: LTV:CAC ≥ target (≥3:1) AND
 * net ARPU × retained &gt; blended CAC. Verifies the thresholds and the boundary at exactly 3:1.
 */
class Phase1To2GateServiceTest {

  private static final double TARGET = 3.0;

  private final Phase1To2GateService service = new Phase1To2GateService();

  @Test
  void goWhenBothConditionsAreMet() {
    // LTV:CAC = 15/5 = 3.0 (exactly the target, MET). net ARPU × retained = 20 × 0.5 = 10 > CAC 5.
    Phase1To2GateResult r =
        service.evaluate(new Phase1To2GateInputs(15.0, 5.0, TARGET, 20.0, 0.5));

    assertThat(r.ltvToCacRatio()).isCloseTo(3.0, within(1e-9));
    assertThat(r.ltvToCacMet()).as("3:1 meets the ≥3:1 target").isTrue();
    assertThat(r.arpuRetainedExceedsCacMet()).isTrue();
    assertThat(r.go()).isTrue();
    assertThat(r.rationale()).startsWith("GO");
  }

  @Test
  void noGoWhenLtvToCacBelowTarget() {
    // LTV:CAC = 10/5 = 2.0 (< 3), even though ARPU × retained (10) > CAC (5).
    Phase1To2GateResult r =
        service.evaluate(new Phase1To2GateInputs(10.0, 5.0, TARGET, 20.0, 0.5));

    assertThat(r.ltvToCacRatio()).isCloseTo(2.0, within(1e-9));
    assertThat(r.ltvToCacMet()).isFalse();
    assertThat(r.go()).isFalse();
    assertThat(r.rationale()).startsWith("NO-GO");
  }

  @Test
  void noGoWhenArpuTimesRetainedDoesNotExceedCac() {
    // LTV:CAC = 20/5 = 4.0 (MET), but net ARPU × retained = 8 × 0.5 = 4.0, which is NOT > CAC 5.
    Phase1To2GateResult r =
        service.evaluate(new Phase1To2GateInputs(20.0, 5.0, TARGET, 8.0, 0.5));

    assertThat(r.ltvToCacMet()).isTrue();
    assertThat(r.netArpuTimesRetainedMinor()).isCloseTo(4.0, within(1e-9));
    assertThat(r.arpuRetainedExceedsCacMet()).isFalse();
    assertThat(r.go()).isFalse();
  }

  @Test
  void zeroCacOrganicClearsTheRatioWhenThereIsAnyLtv() {
    // Pure organic: CAC 0 -> ratio undefined (null) but clears iff LTV > 0. ARPU × retained > 0.
    Phase1To2GateResult r =
        service.evaluate(new Phase1To2GateInputs(10.0, 0.0, TARGET, 1.0, 0.5));

    assertThat(r.ltvToCacRatio()).isNull();
    assertThat(r.ltvToCacMet()).isTrue();
    assertThat(r.arpuRetainedExceedsCacMet()).isTrue(); // 0.5 > 0
    assertThat(r.go()).isTrue();
  }
}
