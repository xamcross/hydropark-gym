package io.hydropark.certification;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Gate 5: localization completeness (SPEC §8.7, P1-20.3). Two angles that the other gates do not
 * cover:
 *
 * <ol>
 *   <li><b>Well-formedness.</b> Every declared locale in {@code resources.strings} and the
 *       {@code localization.default_locale} must be a well-formed BCP-47-ish tag (a 2–3 letter
 *       lowercase primary language subtag with an optional 2-letter uppercase region, e.g. {@code en},
 *       {@code uk}, {@code en-US}). The JSON Schema already constrains the same shape, but this gate
 *       surfaces the defect with a stable, machine-branchable {@code malformed_locale_tag} code and
 *       runs even when schema validation is skipped or relaxed — matching the module's "complete
 *       report in one pass" contract.
 *   <li><b>Default-locale coverage.</b> A {@code default_locale} exists so the app has a fallback
 *       table to fall back <em>to</em> (§8.7). This deliberately does <b>not</b> re-implement the
 *       {@link ReferentialIntegrityCheck} rule that a present {@code default_locale} must be one of
 *       the declared {@code resources.strings} — that gate already owns "default_locale ∈ strings"
 *       (its {@code undeclared_default_locale}). Instead this fills the exact gap that check's
 *       {@code !declaredLocales.isEmpty()} guard skips: a {@code default_locale} declared with
 *       <em>no</em> shipped string tables at all (empty/absent {@code resources.strings}) is
 *       uncovered and would leave the fallback pointing at nothing. The two checks therefore compose
 *       to fully cover "the default locale has a table" without ever double-reporting the same defect.
 * </ol>
 *
 * <p>Null-safe like every gate: it navigates with {@code path(...)} and guards on node type.
 */
public final class LocalizationCompletenessCheck implements CertificationCheck {

  /**
   * BCP-47-ish: a 2–3 letter lowercase primary language subtag with an optional 2-letter uppercase
   * region. Intentionally a pragmatic subset (no script/variant/extension subtags) — that is the full
   * locale vocabulary the manifest uses (§8.7, and the schema's own {@code localeCode}).
   */
  private static final Pattern LOCALE_TAG = Pattern.compile("^[a-z]{2,3}(?:-[A-Z]{2})?$");

  @Override
  public String name() {
    return "localization";
  }

  @Override
  public List<Finding> run(JsonNode m) {
    List<Finding> out = new ArrayList<>();

    JsonNode strings = m.path("resources").path("strings");
    boolean stringsPresent = strings.isArray() && strings.size() > 0;
    if (strings.isArray()) {
      int i = 0;
      for (JsonNode s : strings) {
        String tag = s.isTextual() ? s.asText() : null;
        if (tag == null || !LOCALE_TAG.matcher(tag).matches()) {
          out.add(
              Finding.error(
                  "malformed_locale_tag",
                  "resources.strings[" + i + "] '" + tag + "' is not a well-formed BCP-47 locale tag",
                  "/resources/strings/" + i));
        }
        i++;
      }
    }

    String defaultLocale = m.path("localization").path("default_locale").asText(null);
    if (defaultLocale != null && !LOCALE_TAG.matcher(defaultLocale).matches()) {
      out.add(
          Finding.error(
              "malformed_locale_tag",
              "localization.default_locale '" + defaultLocale + "' is not a well-formed BCP-47 locale tag",
              "/localization/default_locale"));
    }

    // Coverage gap the referential check's non-empty-strings guard deliberately skips: a declared
    // default_locale with no shipped string tables at all has nothing to fall back to.
    if (defaultLocale != null && !stringsPresent) {
      out.add(
          Finding.error(
              "default_locale_not_covered",
              "localization.default_locale '"
                  + defaultLocale
                  + "' has no shipped locale table (resources.strings is empty or absent)",
              "/localization/default_locale"));
    }

    return out;
  }
}
