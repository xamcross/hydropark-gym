package io.hydropark.certification;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * P1-20.3: the localization completeness gate. Covers well-formedness of every declared locale tag
 * and the default-locale coverage gap that {@link ReferentialIntegrityCheck} deliberately does not
 * touch. Plain JUnit — no Spring, no Docker.
 */
class LocalizationCompletenessCheckTest {

  private static final ObjectMapper MAPPER = new ObjectMapper();
  private final LocalizationCompletenessCheck check = new LocalizationCompletenessCheck();

  /** Manifest with the given strings array (JSON) and default_locale (null to omit localization). */
  private static ObjectNode manifest(String stringsJson, String defaultLocale) throws Exception {
    ObjectNode m = MAPPER.createObjectNode();
    if (stringsJson != null) {
      m.putObject("resources").set("strings", MAPPER.readTree(stringsJson));
    }
    if (defaultLocale != null) {
      m.putObject("localization").put("default_locale", defaultLocale);
    }
    return m;
  }

  private static boolean has(List<Finding> findings, String code) {
    return findings.stream().anyMatch(f -> f.code().equals(code));
  }

  @Test
  void wellFormedLocalesWithCoveredDefaultPass() throws Exception {
    List<Finding> f = check.run(manifest("[\"en\", \"uk\", \"en-US\"]", "en"));
    assertThat(f).isEmpty();
  }

  @Test
  void malformedLocaleInStringsIsAnError() throws Exception {
    List<Finding> f = check.run(manifest("[\"en\", \"English\"]", "en"));
    assertThat(has(f, "malformed_locale_tag")).isTrue();
    assertThat(f).anyMatch(x -> x.severity() == Severity.ERROR);
  }

  @Test
  void malformedDefaultLocaleIsAnError() throws Exception {
    // underscore instead of hyphen, and lowercase region — not BCP-47 well-formed
    List<Finding> f = check.run(manifest("[\"en\"]", "en_us"));
    assertThat(has(f, "malformed_locale_tag")).isTrue();
  }

  @Test
  void defaultLocaleWithNoShippedTablesIsUncovered() throws Exception {
    // resources.strings entirely absent: the referential check skips this; this gate catches it.
    List<Finding> f = check.run(manifest(null, "en"));
    assertThat(has(f, "default_locale_not_covered")).isTrue();
  }

  @Test
  void doesNotDuplicateTheReferentialDefaultLocaleMembershipRule() throws Exception {
    // strings present but default_locale not among them: that membership defect belongs to the
    // referential check (undeclared_default_locale). This gate must stay silent about it — both tags
    // are well-formed and strings is non-empty, so it emits nothing.
    List<Finding> f = check.run(manifest("[\"en\"]", "fr"));
    assertThat(f).isEmpty();
  }
}
