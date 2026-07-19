package io.hydropark.analytics;

import org.springframework.stereotype.Service;

/**
 * P1-25.5 - the documented <b>Phase-1 → 2 go/no-go gate</b> (SPEC §25, mirrors P0-10). Two conditions
 * must BOTH hold to advance:
 *
 * <ol>
 *   <li><b>LTV:CAC ≥ target</b> (§25: ≥ 3:1). Under organic-only growth, CAC is content/organic cost,
 *       so a zero-CAC channel clears trivially provided it produced any LTV.
 *   <li><b>net ARPU × retained &gt; blended CAC</b> - the expected net revenue from an acquired user,
 *       discounted by retention, must exceed the cost of acquiring them (read per acquired unit).
 * </ol>
 *
 * <p>A product can hit every usage metric and still be unprofitable; this gate is what actually decides
 * the roadmap. <b>Pure by construction:</b> {@link #evaluate} is a total function over the blended
 * economics {@link CacLtvService}/{@link AnalyticsRollupService} already computed - no datastore.
 */
@Service
public class Phase1To2GateService {

  public record Phase1To2GateInputs(
      double ltvPerInstallMinor,
      double blendedCacPerInstallMinor,
      double ltvToCacTarget,
      double netArpuMinorPerUser,
      double retentionRate) {}

  public record Phase1To2GateResult(
      Double ltvToCacRatio,
      double ltvToCacTarget,
      boolean ltvToCacMet,
      double netArpuTimesRetainedMinor,
      double blendedCacPerInstallMinor,
      boolean arpuRetainedExceedsCacMet,
      boolean go,
      String rationale) {}

  public Phase1To2GateResult evaluate(Phase1To2GateInputs in) {
    double cac = in.blendedCacPerInstallMinor();
    double ltv = in.ltvPerInstallMinor();

    // Condition 1: LTV:CAC ≥ target. Zero (or negative) CAC ⇒ undefined ratio (reported null), which
    // clears iff there is any positive LTV - a free channel that earns anything cannot fail the target.
    Double ratio = cac <= 0.0 ? null : ltv / cac;
    boolean ltvToCacMet = cac <= 0.0 ? ltv > 0.0 : (ltv / cac) >= in.ltvToCacTarget();

    // Condition 2 (§25): net ARPU × retained > blended CAC, per acquired unit.
    double arpuRetained = in.netArpuMinorPerUser() * in.retentionRate();
    boolean arpuRetainedExceedsCacMet = arpuRetained > cac;

    boolean go = ltvToCacMet && arpuRetainedExceedsCacMet;

    return new Phase1To2GateResult(
        ratio,
        in.ltvToCacTarget(),
        ltvToCacMet,
        arpuRetained,
        cac,
        arpuRetainedExceedsCacMet,
        go,
        rationale(go, ltvToCacMet, arpuRetainedExceedsCacMet, ratio, in.ltvToCacTarget(), arpuRetained, cac));
  }

  private static String rationale(
      boolean go,
      boolean ltvToCacMet,
      boolean arpuRetainedExceedsCacMet,
      Double ratio,
      double target,
      double arpuRetained,
      double cac) {
    String ratioStr = ratio == null ? "n/a (zero CAC)" : String.format("%.2f", ratio);
    String c1 =
        "LTV:CAC "
            + ratioStr
            + " vs target "
            + String.format("%.2f", target)
            + " -> "
            + (ltvToCacMet ? "MET" : "NOT MET");
    String c2 =
        "net ARPU × retained "
            + String.format("%.2f", arpuRetained)
            + " vs blended CAC "
            + String.format("%.2f", cac)
            + " -> "
            + (arpuRetainedExceedsCacMet ? "MET" : "NOT MET");
    return (go ? "GO" : "NO-GO") + ": " + c1 + "; " + c2;
  }
}
