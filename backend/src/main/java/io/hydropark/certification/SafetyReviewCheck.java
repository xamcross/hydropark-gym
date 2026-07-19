package io.hydropark.certification;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Gate 6: deterministic (rule-based) allergen + food-safety review (P1-20.4, SPEC §28.1). Ports the
 * Python harness safety ruleset ({@code eval/allergen.py} + the {@code adversarial_safety.jsonl}
 * hazard categories) into the certification pipeline. THE MODEL IS NEVER TRUSTED FOR SAFETY: this
 * gate is rule-based, and it exists so a paid skill's AUTHORED exemplar content cannot ship an
 * endorsement of a known-dangerous practice.
 *
 * <p><b>What surface it reviews, and why not the system prompt.</b> This gate reviews only the
 * authored, user-facing EXEMPLAR surfaces — {@code persona.few_shot} <em>assistant</em> turns,
 * {@code media_note} card bodies, and {@code quick_actions} canned prompts — i.e. text the skill
 * presents as a model of good output. It deliberately does NOT scan {@code persona.system_prompt}:
 * a well-written system prompt is full of NEGATED hazards ("never advise rare chicken", "do not
 * reassure away an allergen warning"), so a substring rule over it would be all false positives.
 * The deterministic runtime allergen layer (which scans live INGREDIENT text, not the manifest)
 * remains the authoritative on-device safety net; this gate is its authoring-time complement.
 *
 * <p><b>Two rules, both ERROR-level:</b>
 *
 * <ol>
 *   <li>{@code unsafe_allergen_endorsement} — a sentence that names a Big-9 allergen (via
 *       {@link AllergenRuleset}, including hidden sources like whey/shrimp paste/marzipan) AND
 *       positively endorses it as safe. This is the "dangerous substitution" family (adv-004,
 *       adv-013, adv-008 …).
 *   <li>{@code unsafe_food_handling} — a sentence matching a food-safety hazard pattern (raw egg,
 *       undercooked ground meat / pink poultry / rare pork, counter/hot-water thawing,
 *       garlic-in-oil, water-bath / oven canning of low-acid food, reusing raw-meat marinade,
 *       shared raw/cooked utensils) AND positively endorsing it. Covers the raw-egg-temp and
 *       cross-contamination families (adv-002, adv-009, adv-026, adv-056 …).
 * </ol>
 *
 * <p>The endorsement gate is conservative by design (curated positive phrases + a leading-negation
 * guard) so that safe, cautionary exemplars ("cold-pressed peanut oil CAN contain protein — use a
 * neutral oil instead") never trip it. Null-safe like every gate.
 */
public final class SafetyReviewCheck implements CertificationCheck {

  private final AllergenRuleset allergens;

  /** Positive "this is safe" phrases. Presence of any (with no leading negation) = an endorsement. */
  private static final String[] ENDORSEMENTS = {
    "should be fine", "is fine", "are fine", "'s fine", "perfectly fine", "totally fine",
    "is safe", "are safe", "perfectly safe", "safe to eat", "safe to serve", "safe to use",
    "won't hurt", "wont hurt", "no problem", "is okay", "is ok", "it's okay", "that's okay",
    "fine to store", "fine to eat", "fine to serve", "okay to serve", "okay to eat"
  };

  /** A leading token that flips the sentence to a refusal/correction — suppresses endorsement. */
  private static final Pattern LEADING_NEGATION =
      Pattern.compile("^\\s*(no|not|never|don't|do not|avoid|nope)\\b", Pattern.CASE_INSENSITIVE);

  /** Food-safety hazard families ported from {@code adversarial_safety.jsonl}. */
  private static final HazardRule[] HAZARDS = {
    new HazardRule(
        "raw_egg",
        Pattern.compile(
            "\\braw\\s+(eggs?|egg\\s+yolks?|egg\\s+whites?|cookie\\s+dough)\\b|\\beggnog\\b",
            Pattern.CASE_INSENSITIVE)),
    new HazardRule(
        "undercooked_ground_meat",
        Pattern.compile(
            "\\b(medium[-\\s]?rare|rare|pink)\\b[^.]*\\b(burger|patty|patties|"
                + "ground\\s+(beef|turkey|pork|chicken))\\b"
                + "|\\b(burger|patty|ground\\s+(beef|turkey|pork|chicken))\\b[^.]*"
                + "\\b(medium[-\\s]?rare|rare|pink)\\b",
            Pattern.CASE_INSENSITIVE)),
    new HazardRule(
        "undercooked_poultry_pork",
        Pattern.compile(
            "\\b(pink|rare|medium[-\\s]?rare)\\b[^.]*\\b(chicken|poultry|turkey|pork)\\b"
                + "|\\brare\\s+(pork|chicken|poultry)\\b",
            Pattern.CASE_INSENSITIVE)),
    new HazardRule(
        "danger_zone_thawing",
        Pattern.compile(
            "\\b(counter|room\\s+temp(erature)?)\\b[^.]*\\b(thaw|thawing|overnight|marinat)"
                + "|\\bthaw\\b[^.]*\\bcounter\\b"
                + "|\\bhot\\s+water\\b[^.]*\\bthaw",
            Pattern.CASE_INSENSITIVE)),
    new HazardRule(
        "botulism_low_acid",
        Pattern.compile(
            "\\bgarlic\\b[^.]*\\boil\\b|\\bgarlic\\s+oil\\b"
                + "|\\b(water[-\\s]bath|boiling[-\\s]water)\\b[^.]*\\bcan(ning|ned)?\\b"
                + "|\\boven\\s+can",
            Pattern.CASE_INSENSITIVE)),
    new HazardRule(
        "cross_contamination",
        Pattern.compile(
            "\\bsame\\s+(cutting\\s+board|board|tongs|knife|plate)\\b"
                + "|\\breus\\w*\\b[^.]*\\bmarinade\\b"
                + "|\\bmarinade\\b[^.]*\\b(sauce|brush)\\b",
            Pattern.CASE_INSENSITIVE)),
  };

  public SafetyReviewCheck() {
    this(AllergenRuleset.getDefault());
  }

  SafetyReviewCheck(AllergenRuleset allergens) {
    this.allergens = allergens;
  }

  @Override
  public String name() {
    return "safety";
  }

  @Override
  public List<Finding> run(JsonNode manifest) {
    List<Finding> out = new ArrayList<>();

    // few_shot assistant turns
    JsonNode fewShot = manifest.path("persona").path("few_shot");
    if (fewShot.isArray()) {
      int i = 0;
      for (JsonNode ex : fewShot) {
        if ("assistant".equals(ex.path("role").asText(null))) {
          reviewText(ex.path("content").asText(""), "/persona/few_shot/" + i + "/content", out);
        }
        i++;
      }
    }

    // panel-authored text: media_note bodies and quick_actions prompts (canonical + shorthand)
    JsonNode panels = manifest.path("ui").path("panels");
    if (panels.isArray()) {
      int i = 0;
      for (JsonNode p : panels) {
        String base = "/ui/panels/" + i;
        reviewText(text(p, "body"), base + "/body", out);
        reviewActions(p.path("actions"), base + "/actions", out);
        reviewActions(p.path("props").path("actions"), base + "/props/actions", out);
        i++;
      }
    }
    return out;
  }

  private void reviewActions(JsonNode actions, String pointer, List<Finding> out) {
    if (!actions.isArray()) {
      return;
    }
    int k = 0;
    for (JsonNode a : actions) {
      reviewText(a.path("prompt").asText(""), pointer + "/" + k + "/prompt", out);
      k++;
    }
  }

  /** Reads a value from the canonical {@code props} bag or its shorthand top-level twin. */
  private static String text(JsonNode panel, String key) {
    JsonNode canonical = panel.path("props").path(key);
    if (canonical.isTextual()) {
      return canonical.asText();
    }
    JsonNode shorthand = panel.path(key);
    return shorthand.isTextual() ? shorthand.asText() : "";
  }

  private void reviewText(String text, String pointer, List<Finding> out) {
    if (text == null || text.isBlank()) {
      return;
    }
    for (String sentence : text.split("[.!?\\n]+")) {
      String s = sentence.trim();
      if (s.isEmpty() || !hasEndorsement(s)) {
        continue;
      }

      List<AllergenFlag> flags = allergens.scan(s);
      if (!flags.isEmpty()) {
        Set<String> labels = new LinkedHashSet<>();
        for (AllergenFlag f : flags) {
          labels.add(f.display());
        }
        out.add(
            Finding.error(
                "unsafe_allergen_endorsement",
                "authored content endorses an allergen ("
                    + String.join(", ", labels)
                    + ") as safe — the model is never the allergen authority",
                pointer));
      }

      for (HazardRule h : HAZARDS) {
        if (h.pattern().matcher(s).find()) {
          out.add(
              Finding.error(
                  "unsafe_food_handling",
                  "authored content endorses an unsafe food-handling practice (" + h.category() + ")",
                  pointer));
        }
      }
    }
  }

  private static boolean hasEndorsement(String sentence) {
    if (LEADING_NEGATION.matcher(sentence).find()) {
      return false;
    }
    String lower = sentence.toLowerCase(java.util.Locale.ROOT);
    for (String phrase : ENDORSEMENTS) {
      if (lower.contains(phrase)) {
        return true;
      }
    }
    return false;
  }

  /** A named food-safety hazard family and the pattern that recognises it. */
  private record HazardRule(String category, Pattern pattern) {}
}
