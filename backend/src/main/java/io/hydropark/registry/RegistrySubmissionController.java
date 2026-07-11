package io.hydropark.registry;

import com.fasterxml.jackson.databind.JsonNode;
import io.hydropark.certification.CertificationReport;
import io.hydropark.common.ApiException;
import io.hydropark.common.ErrorCode;
import io.hydropark.security.CurrentUser;
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
 * registry operation, not something an end-user desktop client calls. {@code SecurityConfig}'s chain
 * rule keeps {@code /v1/registry/**} {@code .authenticated()} (a valid access token, never public);
 * because that alone would admit <em>any</em> logged-in user, this controller additionally enforces an
 * admin gate: the caller's {@code users.id} must appear in the config-driven allowlist {@link
 * RegistryProperties#getAdminUserIds() hydropark.registry.admin-user-ids}, or the request is rejected
 * with {@code 403 forbidden}. The allowlist defaults to empty, so the endpoint is locked down until an
 * operator names admins ({@code HP_REGISTRY_ADMIN_USER_IDS}).
 *
 * <p>Returns HTTP 200 with the report when it passes (zero ERROR findings) and 422 with the report
 * when it does not — the body is the same {@link CertificationReport} either way so the caller sees
 * exactly which gate failed.
 */
@RestController
@RequestMapping("/v1/registry")
public class RegistrySubmissionController {

  private final RegistrySubmissionService submissions;
  private final RegistryProperties registry;

  public RegistrySubmissionController(
      RegistrySubmissionService submissions, RegistryProperties registry) {
    this.submissions = submissions;
    this.registry = registry;
  }

  @PostMapping("/skills:certify")
  public ResponseEntity<CertificationReport> certify(@RequestBody JsonNode manifest) {
    // Admin gate. The filter chain only guarantees an authenticated caller; skill submission is an
    // admin/pipeline op, so require the caller be on the config-driven allowlist. Empty allowlist =
    // locked down. Enforced here (not in the service) so the service stays a pure certify function.
    String userId = CurrentUser.requireUserId();
    if (!registry.isAdmin(userId)) {
      throw new ApiException(
          ErrorCode.FORBIDDEN, "skill submission is restricted to registry administrators");
    }
    CertificationReport report = submissions.certifySubmission(manifest);
    HttpStatus status = report.passed() ? HttpStatus.OK : HttpStatus.UNPROCESSABLE_ENTITY;
    return ResponseEntity.status(status).body(report);
  }
}
