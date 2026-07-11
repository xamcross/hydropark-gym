package io.hydropark.certification;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.ArrayList;
import java.util.List;

/**
 * Gate 7 + the interim {@link BehavioralEvalPort} (P1-20.2). The real behavioral eval — a live model
 * run that produces a certified, MEASURED cost — lives in the separate {@code eval/} harness (see
 * {@link BehavioralEvalPort}). Until that harness is wired in, this adapter stands in with a purely
 * DETERMINISTIC, STRUCTURAL estimate: it does not run a model and never claims to.
 *
 * <p><b>As a {@link BehavioralEvalPort}</b> it returns a computed UPPER BOUND on the skill's prompt
 * tokens — {@code personaTokens + fewShotTokens + tools·PER_TOOL + panels·PER_PANEL} (chars/4
 * heuristic) — flagged {@code measured=false, method="structural_upper_bound"} so the capacity meter
 * knows it is a placeholder, not a measurement.
 *
 * <p><b>As a {@link CertificationCheck}</b> it validates the author's self-declared
 * {@code cost_estimate.prompt_tokens} against that upper bound: because the bound is a ceiling on
 * what the skill can plausibly cost, a declared value that EXCEEDS it beyond {@link #TOLERANCE} is
 * not credible and is surfaced as a WARNING ({@code cost_estimate_above_upper_bound}). It stays a
 * warning, never an error: the authoritative number is the eval's, not this structural proxy, so
 * this gate must never block certification on its own account.
 */
public final class DeclaredCostEstimateAdapter implements CertificationCheck, BehavioralEvalPort {

  private static final double CHARS_PER_TOKEN = 4.0;
  /** Per-tool schema/overhead allowance (name + JSON-schema args), in tokens. */
  static final int PER_TOOL_TOKENS = 120;
  /** Per-panel prompt allowance (widget summary surfaced to the model), in tokens. */
  static final int PER_PANEL_TOKENS = 40;
  /** Allowed slack above the structural upper bound before the declared value is deemed suspect. */
  static final double TOLERANCE = 0.25;

  @Override
  public String name() {
    return "cost_estimate";
  }

  @Override
  public CertifiedCostEstimate estimateCost(JsonNode manifest) {
    Bound b = computeBound(manifest);
    return new CertifiedCostEstimate(b.promptTokens, b.tools, b.panels, false, "structural_upper_bound");
  }

  @Override
  public List<Finding> run(JsonNode manifest) {
    List<Finding> out = new ArrayList<>();
    Bound bound = computeBound(manifest);

    JsonNode declared = manifest.path("cost_estimate").path("prompt_tokens");
    if (declared.isNumber() && bound.promptTokens > 0) {
      double ceiling = bound.promptTokens * (1.0 + TOLERANCE);
      if (declared.asDouble() > ceiling) {
        out.add(
            Finding.warning(
                "cost_estimate_above_upper_bound",
                "cost_estimate.prompt_tokens="
                    + declared.asInt()
                    + " exceeds the structural upper bound of ~"
                    + bound.promptTokens
                    + " tokens (persona + few-shot + tools + panels); the certified figure comes from"
                    + " the behavioral eval (P1-20.2)",
                "/cost_estimate/prompt_tokens"));
      }
    }
    return out;
  }

  private static Bound computeBound(JsonNode manifest) {
    JsonNode persona = manifest.path("persona");
    boolean secondary = "secondary_only".equals(persona.path("role").asText("primary_eligible"));
    String personaText =
        secondary
            ? persona.path("compressed_prompt").asText("")
            : persona.path("system_prompt").asText("");
    int personaTokens = tokens(personaText.length());

    int fewShotTokens = 0;
    JsonNode fewShot = persona.path("few_shot");
    if (fewShot.isArray()) {
      for (JsonNode ex : fewShot) {
        fewShotTokens += tokens(ex.path("content").asText("").length());
      }
    }

    int tools = count(manifest.path("tools"));
    int panels = count(manifest.path("ui").path("panels"));
    int promptTokens =
        personaTokens + fewShotTokens + tools * PER_TOOL_TOKENS + panels * PER_PANEL_TOKENS;
    return new Bound(promptTokens, tools, panels);
  }

  private static int tokens(int chars) {
    return (int) Math.ceil(chars / CHARS_PER_TOKEN);
  }

  private static int count(JsonNode n) {
    return n.isArray() ? n.size() : 0;
  }

  private record Bound(int promptTokens, int tools, int panels) {}
}
