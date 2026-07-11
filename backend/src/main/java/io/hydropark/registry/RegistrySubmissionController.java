package io.hydropark.registry;

import com.fasterxml.jackson.databind.JsonNode;
import io.hydropark.certification.CertificationReport;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Registry submission endpoint (P1-19 / P1-20): verify a submitted skill package's signature and run
 * it through the certification gate, returning the {@link CertificationReport}.
 *
 * <p><b>Intent: internal/admin, not a public client route.</b> Skill packaging + certification is a
 * registry operation, not something an end-user desktop client calls. Route authorization is left to
 * the orchestrator (SecurityConfig is owned elsewhere): with the current config {@code
 * /v1/registry/**} falls through to {@code anyRequest().authenticated()}, so it already requires a
 * valid access token and is never public — but it SHOULD be locked down further (admin authority, or
 * relocation behind the {@code /internal/**} InternalAuthFilter edge). See this ticket's report.
 *
 * <p>Returns HTTP 200 with the report when it passes (zero ERROR findings) and 422 with the report
 * when it does not — the body is the same {@link CertificationReport} either way so the caller sees
 * exactly which gate failed.
 */
@RestController
@RequestMapping("/v1/registry")
public class RegistrySubmissionController {

  private final RegistrySubmissionService submissions;

  public RegistrySubmissionController(RegistrySubmissionService submissions) {
    this.submissions = submissions;
  }

  @PostMapping("/skills:certify")
  public ResponseEntity<CertificationReport> certify(@RequestBody JsonNode manifest) {
    CertificationReport report = submissions.certifySubmission(manifest);
    HttpStatus status = report.passed() ? HttpStatus.OK : HttpStatus.UNPROCESSABLE_ENTITY;
    return ResponseEntity.status(status).body(report);
  }
}
