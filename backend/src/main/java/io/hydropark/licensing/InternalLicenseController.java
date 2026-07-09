package io.hydropark.licensing;

import io.hydropark.port.Ports.IssuedLicense;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * The issuer zone's internal entrypoint (BACKEND-DESIGN §6). Exists only where
 * {@code hydropark.issuer.enabled=true}. It has no public ingress - the hosting Fly app takes none,
 * and {@code InternalAuthFilter} has already rejected anything reaching {@code /internal/**} without
 * a valid internal token (constant-time compared).
 *
 * <p>It delegates straight to {@link LocalLicenseIssuer}, which re-verifies settlement, slot, and
 * rate limits itself - the token that got the caller past the filter authorizes reaching the
 * Issuer, not what it may sign.
 */
@RestController
@ConditionalOnProperty(name = "hydropark.issuer.enabled", havingValue = "true")
public class InternalLicenseController {

  private final LocalLicenseIssuer issuer;

  public InternalLicenseController(LocalLicenseIssuer issuer) {
    this.issuer = issuer;
  }

  @PostMapping("/internal/licenses/issue")
  public IssuedLicense issue(@RequestBody InternalIssueRequest req) {
    return issuer.issue(req.userId(), req.skillId(), req.deviceId());
  }
}
