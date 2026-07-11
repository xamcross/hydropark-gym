package io.hydropark.certification;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Gate 2: cross-field referential integrity that JSON Schema cannot express (the manifest author
 * flagged these for the lint). Every panel {@code binds_tool} must name a declared tool; every
 * {@code binds_state} and every tool {@code reads_state}/{@code writes_state} must name a declared
 * shared_state slot; panel ids must be unique; {@code localization.default_locale} must be a declared
 * string locale; the icon should be among the assets; and {@code cost_estimate.tools/panels} should
 * match the actual counts (warning). Null-safe: works on shorthand or canonical manifests.
 */
public final class ReferentialIntegrityCheck implements CertificationCheck {

  @Override
  public String name() {
    return "referential";
  }

  @Override
  public List<Finding> run(JsonNode m) {
    List<Finding> out = new ArrayList<>();

    JsonNode toolsNode = m.path("tools");
    Set<String> declaredTools = new HashSet<>();
    if (toolsNode.isArray()) {
      for (JsonNode t : toolsNode) {
        String ref = t.path("ref").asText(null);
        if (ref != null) {
          declaredTools.add(ref);
        }
      }
    }

    Set<String> declaredSlots = new HashSet<>();
    JsonNode sharedState = m.path("shared_state");
    if (sharedState.isArray()) {
      for (JsonNode s : sharedState) {
        String slot = s.path("slot").asText(null);
        if (slot != null) {
          declaredSlots.add(slot);
        }
      }
    }

    Set<String> declaredLocales = new HashSet<>();
    JsonNode strings = m.path("resources").path("strings");
    if (strings.isArray()) {
      for (JsonNode s : strings) {
        declaredLocales.add(s.asText());
      }
    }

    // Each tool's reads_state / writes_state must reference a declared slot.
    if (toolsNode.isArray()) {
      int i = 0;
      for (JsonNode t : toolsNode) {
        checkStateRefs(t.path("reads_state"), declaredSlots, out, "/tools/" + i + "/reads_state");
        checkStateRefs(t.path("writes_state"), declaredSlots, out, "/tools/" + i + "/writes_state");
        i++;
      }
    }

    // Panels: unique ids, valid tool/state bindings.
    JsonNode panels = m.path("ui").path("panels");
    Set<String> seenIds = new HashSet<>();
    if (panels.isArray()) {
      int i = 0;
      for (JsonNode p : panels) {
        String pointer = "/ui/panels/" + i;
        String id = p.path("id").asText(null);
        if (id != null && !seenIds.add(id)) {
          out.add(
              Finding.error("duplicate_panel_id", "panel id '" + id + "' is not unique", pointer + "/id"));
        }
        String bindsTool = p.path("binds_tool").asText(null);
        if (bindsTool != null && !declaredTools.contains(bindsTool)) {
          out.add(
              Finding.error(
                  "unknown_tool_ref",
                  "panel binds_tool '" + bindsTool + "' is not a declared tool",
                  pointer + "/binds_tool"));
        }
        String bindsState = p.path("binds_state").asText(null);
        if (bindsState != null && !declaredSlots.contains(bindsState)) {
          out.add(
              Finding.error(
                  "unknown_state_ref",
                  "panel binds_state '" + bindsState + "' is not a declared shared_state slot",
                  pointer + "/binds_state"));
        }
        i++;
      }
    }

    String defaultLocale = m.path("localization").path("default_locale").asText(null);
    if (defaultLocale != null && !declaredLocales.isEmpty() && !declaredLocales.contains(defaultLocale)) {
      out.add(
          Finding.error(
              "undeclared_default_locale",
              "localization.default_locale '" + defaultLocale + "' is not in resources.strings",
              "/localization/default_locale"));
    }

    String icon = m.path("resources").path("icon").asText(null);
    JsonNode assets = m.path("resources").path("assets");
    if (icon != null && assets.isArray()) {
      boolean found = false;
      for (JsonNode a : assets) {
        if (icon.equals(a.asText())) {
          found = true;
          break;
        }
      }
      if (!found) {
        out.add(
            Finding.warning(
                "icon_not_in_assets",
                "resources.icon '" + icon + "' is not listed in resources.assets",
                "/resources/icon"));
      }
    }

    JsonNode cost = m.path("cost_estimate");
    if (cost.isObject()) {
      int actualTools = toolsNode.isArray() ? toolsNode.size() : 0;
      int actualPanels = panels.isArray() ? panels.size() : 0;
      int declaredToolCount = cost.path("tools").asInt(-1);
      int declaredPanelCount = cost.path("panels").asInt(-1);
      if (declaredToolCount >= 0 && declaredToolCount != actualTools) {
        out.add(
            Finding.warning(
                "cost_estimate_tools_mismatch",
                "cost_estimate.tools=" + declaredToolCount + " but " + actualTools + " tools declared",
                "/cost_estimate/tools"));
      }
      if (declaredPanelCount >= 0 && declaredPanelCount != actualPanels) {
        out.add(
            Finding.warning(
                "cost_estimate_panels_mismatch",
                "cost_estimate.panels=" + declaredPanelCount + " but " + actualPanels + " panels declared",
                "/cost_estimate/panels"));
      }
    }

    return out;
  }

  private static void checkStateRefs(
      JsonNode refs, Set<String> declaredSlots, List<Finding> out, String pointer) {
    if (!refs.isArray()) {
      return;
    }
    int i = 0;
    for (JsonNode r : refs) {
      String slot = r.asText();
      if (!declaredSlots.contains(slot)) {
        out.add(
            Finding.error(
                "unknown_state_ref",
                "state ref '" + slot + "' is not a declared shared_state slot",
                pointer + "/" + i));
      }
      i++;
    }
  }
}
