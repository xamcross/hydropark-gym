package io.hydropark.certification;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.List;

/**
 * One automated gate in the skill-certification pipeline (SPEC §8.5, P1-20.1). Implementations MUST
 * be null-safe: every check runs even against a manifest that already failed schema validation (so
 * the report is complete in one pass), so they navigate with {@code JsonNode.path(...)} and guard on
 * node type rather than assuming shape.
 */
public interface CertificationCheck {

  String name();

  List<Finding> run(JsonNode manifest);
}
