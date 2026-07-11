package io.hydropark.certification;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.util.ArrayList;
import java.util.List;
import org.springframework.stereotype.Service;

/**
 * The skill-certification gate (SPEC §8.5, P1-20.1): runs the automated checks over a skill manifest
 * and returns a {@link CertificationReport}. A manifest is certifiable iff zero ERROR findings. All
 * checks run every time (they are null-safe), so an authoring failure surfaces every problem in one
 * pass instead of one-at-a-time.
 *
 * <p>Wired as a Spring bean for the registry/submission path (P1-19/P1-20), but constructible plainly
 * (no Spring context) so the checks stay fast to unit-test.
 */
@Service
public class CertificationService {

  private static final String SCHEMA_RESOURCE = "/certification/skill-manifest.schema.json";

  private final List<CertificationCheck> checks;

  public CertificationService() {
    this(loadDefaultSchema());
  }

  public CertificationService(JsonNode manifestSchema) {
    this.checks =
        List.of(
            new SchemaValidationCheck(manifestSchema),
            new ReferentialIntegrityCheck(),
            new BudgetLimitsCheck(),
            new NonTokenStylingLintCheck());
  }

  public CertificationReport certify(JsonNode manifest) {
    List<Finding> all = new ArrayList<>();
    for (CertificationCheck check : checks) {
      all.addAll(check.run(manifest));
    }
    return new CertificationReport(manifest.path("id").asText("<unknown>"), all);
  }

  static JsonNode loadDefaultSchema() {
    try (InputStream in = CertificationService.class.getResourceAsStream(SCHEMA_RESOURCE)) {
      if (in == null) {
        throw new IllegalStateException("missing classpath resource " + SCHEMA_RESOURCE);
      }
      return new ObjectMapper().readTree(in);
    } catch (IOException e) {
      throw new UncheckedIOException("failed to load manifest schema", e);
    }
  }
}
