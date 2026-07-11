package io.hydropark.certification;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Gate 4: non-token-styling lint (pairs with P1-03.8). Skills may reference the constrained
 * design-token vocabulary by name only, never raw style values (SPEC §9.1/§9.10). This walks the
 * manifest — excluding the natural-language {@code persona} subtree, whose prose legitimately mentions
 * things like "165F" or "400 g" — and rejects hard-coded colors (hex / rgb / hsl) and raw CSS length
 * units. Null-safe.
 */
public final class NonTokenStylingLintCheck implements CertificationCheck {

  private static final Pattern HEX_COLOR = Pattern.compile("#[0-9a-fA-F]{3,8}\\b");
  private static final Pattern COLOR_FN = Pattern.compile("\\b(rgba?|hsla?)\\s*\\(");
  private static final Pattern CSS_LENGTH = Pattern.compile("\\b\\d+(?:\\.\\d+)?(px|rem|em|pt|vh|vw)\\b");

  @Override
  public String name() {
    return "styling";
  }

  @Override
  public List<Finding> run(JsonNode manifest) {
    List<Finding> out = new ArrayList<>();
    walk(manifest, "", out);
    return out;
  }

  private void walk(JsonNode node, String pointer, List<Finding> out) {
    if (node.isObject()) {
      Iterator<Map.Entry<String, JsonNode>> it = node.fields();
      while (it.hasNext()) {
        Map.Entry<String, JsonNode> e = it.next();
        // persona is natural-language prose, not a styling surface.
        if (pointer.isEmpty() && e.getKey().equals("persona")) {
          continue;
        }
        walk(e.getValue(), pointer + "/" + e.getKey(), out);
      }
    } else if (node.isArray()) {
      int i = 0;
      for (JsonNode child : node) {
        walk(child, pointer + "/" + i, out);
        i++;
      }
    } else if (node.isTextual()) {
      String v = node.asText();
      if (HEX_COLOR.matcher(v).find() || COLOR_FN.matcher(v).find() || CSS_LENGTH.matcher(v).find()) {
        out.add(
            Finding.error(
                "non_token_style",
                "raw style value '" + truncate(v) + "' - skills must reference design tokens, not literals",
                pointer));
      }
    }
  }

  private static String truncate(String s) {
    return s.length() <= 40 ? s : s.substring(0, 40) + "...";
  }
}
