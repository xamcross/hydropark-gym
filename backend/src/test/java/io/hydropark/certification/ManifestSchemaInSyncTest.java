package io.hydropark.certification;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.File;
import java.io.InputStream;
import org.junit.jupiter.api.Test;

/**
 * DRIFT GUARD: {@code backend/src/main/resources/certification/skill-manifest.schema.json} is a COPY
 * of the source-of-truth {@code contracts/skill-manifest.schema.json} at the repo root. Nothing keeps
 * the two in lockstep automatically, so they can silently diverge — and {@link CertificationService}
 * loads the shipped classpath copy, meaning a stale copy would certify manifests against an outdated
 * contract. This test fails the build the moment they differ. Plain JUnit — no Spring context, no
 * Docker.
 *
 * <p>Not run as part of the authoring change (AGENT-CONTRACT: "Do not run mvn").
 */
class ManifestSchemaInSyncTest {

  private static final ObjectMapper MAPPER = new ObjectMapper();

  /** The classpath resource {@link CertificationService} actually ships and loads. */
  private static final String SHIPPED_RESOURCE = "/certification/skill-manifest.schema.json";

  /**
   * The source of truth, resolved from the filesystem. Surefire runs with the working directory set
   * to the module directory ({@code backend/}), so this relative path resolves to the repo-root
   * {@code contracts/} file.
   */
  private static final String SOURCE_OF_TRUTH = "../contracts/skill-manifest.schema.json";

  @Test
  void shippedSchemaMatchesContractsSourceOfTruth() throws Exception {
    JsonNode shipped;
    try (InputStream in = getClass().getResourceAsStream(SHIPPED_RESOURCE)) {
      assertThat(in)
          .as("missing shipped classpath resource %s", SHIPPED_RESOURCE)
          .isNotNull();
      shipped = MAPPER.readTree(in);
    }

    File source = new File(SOURCE_OF_TRUTH);
    assertThat(source)
        .as(
            "source-of-truth schema not found at %s (resolved to %s). This test assumes surefire's"
                + " working directory is the module dir (backend/); if that assumption is wrong, or"
                + " the repo-root contracts/ file was moved/removed, fix the path — do NOT let this"
                + " test silently pass.",
            SOURCE_OF_TRUTH, source.getAbsolutePath())
        .isFile();

    JsonNode truth = MAPPER.readTree(source);

    // Compare parsed JSON trees, not raw bytes: JsonNode equality ignores insignificant whitespace,
    // line-ending (CRLF vs LF) and trailing-newline differences, so those never cause a false alarm.
    assertThat(shipped)
        .as(
            "%s has DRIFTED from the source of truth %s. Re-copy contracts/skill-manifest.schema.json"
                + " into backend/src/main/resources/certification/ so the certification pipeline"
                + " enforces the current contract.",
            SHIPPED_RESOURCE, SOURCE_OF_TRUTH)
        .isEqualTo(truth);
  }
}
