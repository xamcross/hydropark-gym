package io.hydropark.certification;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.InputStream;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * P1-20.2: the interim {@link BehavioralEvalPort} stand-in. Verifies the structural upper-bound
 * computation, the divergence warning, the role-sensitive persona accounting, and that the port
 * clearly reports its estimate as UNMEASURED (never a fabricated model run). Plain JUnit — no Spring,
 * no Docker.
 */
class DeclaredCostEstimateAdapterTest {

  private static final ObjectMapper MAPPER = new ObjectMapper();
  private final DeclaredCostEstimateAdapter adapter = new DeclaredCostEstimateAdapter();

  @Test
  void declaredTokensAboveTheUpperBoundIsAWarning() {
    ObjectNode m = MAPPER.createObjectNode();
    m.putObject("persona").put("system_prompt", "a short persona prompt");
    m.putObject("cost_estimate").put("prompt_tokens", 100_000);

    List<Finding> f = adapter.run(m);
    assertThat(f)
        .anyMatch(
            x ->
                x.code().equals("cost_estimate_above_upper_bound")
                    && x.severity() == Severity.WARNING);
  }

  @Test
  void plausibleDeclarationProducesNoFinding() throws Exception {
    assertThat(adapter.run(example("kitchen-timer.manifest.json"))).isEmpty();
  }

  @Test
  void referenceManifestsAreNotFlagged() throws Exception {
    assertThat(adapter.run(example("kitchen-timer.manifest.json"))).isEmpty();
    assertThat(adapter.run(example("cooking-assistant.manifest.json"))).isEmpty();
  }

  @Test
  void estimateCostReturnsAnUnmeasuredStructuralBound() throws Exception {
    CertifiedCostEstimate est = adapter.estimateCost(example("kitchen-timer.manifest.json"));
    assertThat(est.measured()).as("must never claim to be a live model run").isFalse();
    assertThat(est.method()).isEqualTo("structural_upper_bound");
    assertThat(est.tools()).isEqualTo(3);
    assertThat(est.panels()).isEqualTo(3);
    assertThat(est.promptTokens()).isGreaterThan(0);
  }

  @Test
  void secondaryRolePersonaUsesTheCompressedPrompt() {
    ObjectNode m = MAPPER.createObjectNode();
    ObjectNode persona = m.putObject("persona");
    persona.put("role", "secondary_only");
    persona.put("system_prompt", "x".repeat(40_000)); // must NOT be counted for a secondary skill
    persona.put("compressed_prompt", "short");

    CertifiedCostEstimate est = adapter.estimateCost(m);
    // Only the ~5-char compressed prompt counts; no tools/panels → a tiny bound, not ~10k tokens.
    assertThat(est.promptTokens()).isLessThan(50);
  }

  @Test
  void primaryRolePersonaCountsTheFullSystemPrompt() {
    ObjectNode m = MAPPER.createObjectNode();
    m.putObject("persona").put("system_prompt", "x".repeat(4_000)); // ~1000 tokens

    CertifiedCostEstimate est = adapter.estimateCost(m);
    assertThat(est.promptTokens()).isGreaterThan(500);
  }

  private static ObjectNode example(String file) throws Exception {
    try (InputStream in =
        DeclaredCostEstimateAdapterTest.class.getResourceAsStream(
            "/certification/examples/" + file)) {
      assertThat(in).as("test resource %s", file).isNotNull();
      return (ObjectNode) MAPPER.readTree(in);
    }
  }
}
