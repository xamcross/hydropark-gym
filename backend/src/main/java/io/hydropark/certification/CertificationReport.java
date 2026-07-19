package io.hydropark.certification;

import java.util.List;

/**
 * The result of running the certification gates (SPEC §8.5, P1-20.1) over a skill manifest. A skill
 * is certifiable iff there are zero {@link Severity#ERROR} findings; warnings are surfaced but do not
 * block. Carries no {@code system_prompt} (IP stays in the signed package).
 */
public record CertificationReport(String skillId, List<Finding> findings) {

  public boolean passed() {
    return findings.stream().noneMatch(f -> f.severity() == Severity.ERROR);
  }

  public List<Finding> errors() {
    return findings.stream().filter(f -> f.severity() == Severity.ERROR).toList();
  }

  public List<Finding> warnings() {
    return findings.stream().filter(f -> f.severity() == Severity.WARNING).toList();
  }

  public boolean hasCode(String code) {
    return findings.stream().anyMatch(f -> f.code().equals(code));
  }
}
