package io.hydropark.certification;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.InputStream;
import org.junit.jupiter.api.Test;

/**
 * P1-20.1: the certification gate passes the two reference manifests and catches crafted defects
 * across all four gates (schema, referential integrity, budget, non-token styling). Plain JUnit — no
 * Spring context, no Docker.
 */
class CertificationServiceTest {

  private static final ObjectMapper MAPPER = new ObjectMapper();
  private final CertificationService service = new CertificationService();

  private static ObjectNode example(String file) throws Exception {
    try (InputStream in =
        CertificationServiceTest.class.getResourceAsStream(
            "/certification/examples/" + file)) {
      assertThat(in).as("test resource %s", file).isNotNull();
      return (ObjectNode) MAPPER.readTree(in);
    }
  }

  private static ObjectNode kitchenTimer() throws Exception {
    return example("kitchen-timer.manifest.json");
  }

  private static ObjectNode panel(ObjectNode manifest, int i) {
    return (ObjectNode) ((ArrayNode) manifest.get("ui").get("panels")).get(i);
  }

  @Test
  void referenceManifestsAreCertifiable() throws Exception {
    CertificationReport kt = service.certify(kitchenTimer());
    assertThat(kt.passed()).as("kitchen-timer errors: %s", kt.errors()).isTrue();

    CertificationReport ca = service.certify(example("cooking-assistant.manifest.json"));
    assertThat(ca.passed()).as("cooking-assistant errors: %s", ca.errors()).isTrue();
  }

  @Test
  void missingRequiredIdFailsSchema() throws Exception {
    ObjectNode m = kitchenTimer();
    m.remove("id");
    CertificationReport r = service.certify(m);
    assertThat(r.passed()).isFalse();
    assertThat(r.hasCode("schema_violation")).isTrue();
  }

  @Test
  void unknownWidgetTypeFailsSchema() throws Exception {
    ObjectNode m = kitchenTimer();
    panel(m, 0).put("type", "hologram");
    CertificationReport r = service.certify(m);
    assertThat(r.passed()).isFalse();
    assertThat(r.hasCode("schema_violation")).isTrue();
  }

  @Test
  void unknownToolBindingFailsReferential() throws Exception {
    ObjectNode m = kitchenTimer();
    panel(m, 0).put("binds_tool", "teleport");
    CertificationReport r = service.certify(m);
    assertThat(r.hasCode("unknown_tool_ref")).as("findings: %s", r.findings()).isTrue();
    assertThat(r.passed()).isFalse();
  }

  @Test
  void unknownStateBindingFailsReferential() throws Exception {
    ObjectNode m = kitchenTimer();
    panel(m, 1).put("binds_state", "nonexistent");
    CertificationReport r = service.certify(m);
    assertThat(r.hasCode("unknown_state_ref")).isTrue();
  }

  @Test
  void duplicatePanelIdFailsReferential() throws Exception {
    ObjectNode m = kitchenTimer();
    panel(m, 1).put("id", panel(m, 0).get("id").asText());
    CertificationReport r = service.certify(m);
    assertThat(r.hasCode("duplicate_panel_id")).isTrue();
  }

  @Test
  void undeclaredDefaultLocaleFailsReferential() throws Exception {
    ObjectNode m = kitchenTimer();
    ((ObjectNode) m.get("localization")).put("default_locale", "zz");
    CertificationReport r = service.certify(m);
    assertThat(r.hasCode("undeclared_default_locale")).isTrue();
  }

  @Test
  void rawColorFailsStylingLint() throws Exception {
    ObjectNode m = kitchenTimer();
    panel(m, 0).put("accent", "#ff0000");
    CertificationReport r = service.certify(m);
    assertThat(r.hasCode("non_token_style")).isTrue();
    assertThat(r.passed()).isFalse();
  }

  @Test
  void oversizePromptFailsBudget() throws Exception {
    ObjectNode m = kitchenTimer();
    ((ObjectNode) m.get("persona")).put("system_prompt", "x".repeat(8000));
    CertificationReport r = service.certify(m);
    assertThat(r.hasCode("over_prompt_budget")).isTrue();
    assertThat(r.passed()).isFalse();
  }

  @Test
  void tooManyToolsFailsBudget() throws Exception {
    ObjectNode m = kitchenTimer();
    ArrayNode tools = (ArrayNode) m.get("tools");
    while (tools.size() < 9) {
      tools.add(MAPPER.createObjectNode().put("ref", "calculate"));
    }
    CertificationReport r = service.certify(m);
    assertThat(r.hasCode("over_tool_budget")).isTrue();
  }
}
