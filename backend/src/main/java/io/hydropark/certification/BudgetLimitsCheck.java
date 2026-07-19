package io.hydropark.certification;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.ArrayList;
import java.util.List;

/**
 * Gate 3: budget limits (SPEC §8.5, §9.10). Caps the persona prompt size, tool count, panel count,
 * and asset count so one skill cannot blow the shared context/latency budget. The token count is a
 * coarse chars/4 heuristic — the certified token budget comes from the behavioral eval (P1-20.2);
 * this gate is the cheap structural backstop and also sanity-checks the authored
 * {@code cost_estimate.prompt_tokens} against the estimate. Null-safe.
 */
public final class BudgetLimitsCheck implements CertificationCheck {

  static final int MAX_PROMPT_TOKENS = 1500;
  static final int MAX_TOOLS = 8;
  static final int MAX_PANELS = 8;
  static final int MAX_ASSETS = 20;
  private static final double CHARS_PER_TOKEN = 4.0;

  @Override
  public String name() {
    return "budget";
  }

  @Override
  public List<Finding> run(JsonNode m) {
    List<Finding> out = new ArrayList<>();

    String systemPrompt = m.path("persona").path("system_prompt").asText("");
    int estTokens = (int) Math.ceil(systemPrompt.length() / CHARS_PER_TOKEN);
    if (estTokens > MAX_PROMPT_TOKENS) {
      out.add(
          Finding.error(
              "over_prompt_budget",
              "system_prompt ~" + estTokens + " tokens exceeds the " + MAX_PROMPT_TOKENS + "-token budget",
              "/persona/system_prompt"));
    }

    JsonNode declaredPromptTokens = m.path("cost_estimate").path("prompt_tokens");
    if (declaredPromptTokens.isNumber() && estTokens > 0) {
      double ratio = declaredPromptTokens.asDouble() / estTokens;
      if (ratio < 0.4 || ratio > 2.5) {
        out.add(
            Finding.warning(
                "cost_estimate_prompt_tokens_suspect",
                "cost_estimate.prompt_tokens="
                    + declaredPromptTokens.asInt()
                    + " is far from the ~"
                    + estTokens
                    + "-token estimate",
                "/cost_estimate/prompt_tokens"));
      }
    }

    int tools = countArray(m.path("tools"));
    if (tools > MAX_TOOLS) {
      out.add(Finding.error("over_tool_budget", tools + " tools exceeds the max of " + MAX_TOOLS, "/tools"));
    }
    int panels = countArray(m.path("ui").path("panels"));
    if (panels > MAX_PANELS) {
      out.add(
          Finding.error("over_panel_budget", panels + " panels exceeds the max of " + MAX_PANELS, "/ui/panels"));
    }
    int assets = countArray(m.path("resources").path("assets"));
    if (assets > MAX_ASSETS) {
      out.add(
          Finding.warning(
              "over_asset_budget", assets + " assets exceeds the soft max of " + MAX_ASSETS, "/resources/assets"));
    }
    return out;
  }

  private static int countArray(JsonNode n) {
    return n.isArray() ? n.size() : 0;
  }
}
