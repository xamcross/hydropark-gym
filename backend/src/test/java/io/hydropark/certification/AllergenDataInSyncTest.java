package io.hydropark.certification;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.File;
import java.io.InputStream;
import org.junit.jupiter.api.Test;

/**
 * DRIFT GUARD (P1-20.4): {@code backend/src/main/resources/certification/allergens.json} is a COPY of
 * the ONE canonical, single-source allergen map that the shipped Rust app embeds and the H2 harness
 * reads ({@code client/src-tauri/src/skills/allergen/allergens.json}). The deterministic allergen
 * layer is safety-critical, so a silently stale backend copy would certify against an outdated Big-9
 * map. This test fails the build the moment the two diverge — the same pattern as
 * {@link ManifestSchemaInSyncTest}. Plain JUnit — no Spring context, no Docker.
 *
 * <p>Not run as part of the authoring change (AGENT-CONTRACT: "Do not run mvn").
 */
class AllergenDataInSyncTest {

  private static final ObjectMapper MAPPER = new ObjectMapper();

  /** The classpath resource {@link AllergenRuleset} actually ships and loads. */
  private static final String SHIPPED_RESOURCE = "/certification/allergens.json";

  /**
   * The canonical source of truth, resolved from the filesystem. Surefire runs with the working
   * directory set to the module directory ({@code backend/}), so this relative path resolves to the
   * repo's client tree.
   */
  private static final String SOURCE_OF_TRUTH =
      "../client/src-tauri/src/skills/allergen/allergens.json";

  @Test
  void shippedAllergenMapMatchesCanonicalSource() throws Exception {
    JsonNode shipped;
    try (InputStream in = getClass().getResourceAsStream(SHIPPED_RESOURCE)) {
      assertThat(in).as("missing shipped classpath resource %s", SHIPPED_RESOURCE).isNotNull();
      shipped = MAPPER.readTree(in);
    }

    File source = new File(SOURCE_OF_TRUTH);
    assertThat(source)
        .as(
            "canonical allergen data not found at %s (resolved to %s). This test assumes surefire's"
                + " working directory is the module dir (backend/); if that assumption is wrong, or"
                + " the client allergen file was moved, fix the path — do NOT let this test silently"
                + " pass.",
            SOURCE_OF_TRUTH, source.getAbsolutePath())
        .isFile();

    JsonNode truth = MAPPER.readTree(source);

    // Compare parsed JSON trees, not raw bytes: JsonNode equality ignores whitespace, line-ending
    // (CRLF vs LF) and trailing-newline differences, so those never cause a false alarm.
    assertThat(shipped)
        .as(
            "%s has DRIFTED from the canonical source %s. Re-copy the client allergen map into"
                + " backend/src/main/resources/certification/ so the safety gate scores against the"
                + " data the app ships.",
            SHIPPED_RESOURCE, SOURCE_OF_TRUTH)
        .isEqualTo(truth);
  }
}
