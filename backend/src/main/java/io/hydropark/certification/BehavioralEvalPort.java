package io.hydropark.certification;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * The certification seam to the behavioral evaluation suite (P1-20.2, PHASE0-PLAN §4b). An
 * implementation returns a {@link CertifiedCostEstimate} for a skill manifest — the figure the
 * capacity meter trusts (§8.3.5).
 *
 * <p><b>The live behavioral eval runs in a SEPARATE harness</b> — the Python H2 suite under
 * {@code eval/} ({@code harness.py} / {@code model_client.py}), which loads the real base model and
 * runs each prompt through both a pure-model and a full-system pass. That harness is the ONLY thing
 * that may produce a {@code measured=true} estimate. This interface is deliberately just the seam: an
 * adapter here MUST NOT fabricate model runs or invent measured token counts. Until the harness is
 * wired to this port, the shipped implementation is {@link DeclaredCostEstimateAdapter}, which
 * returns a deterministic, clearly-unmeasured structural upper bound.
 */
public interface BehavioralEvalPort {

  /**
   * Certify the resource cost of {@code manifest}. Implementations that run the live eval return a
   * {@code measured=true} estimate; the deterministic stand-in returns {@code measured=false}.
   */
  CertifiedCostEstimate estimateCost(JsonNode manifest);
}
