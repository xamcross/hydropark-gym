package io.hydropark.licensing;

import com.fasterxml.jackson.annotation.JsonProperty;
import io.hydropark.common.CursorPage;
import io.hydropark.port.Ports;
import io.hydropark.port.Ports.IssuedLicense;
import io.hydropark.port.Ports.LicenseIssuerPort;
import io.hydropark.port.Ports.StepUpPort;
import io.hydropark.security.CurrentUser;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Public license endpoints (BACKEND-DESIGN §4.4), api zone only. The controller is deliberately thin:
 * it authenticates, enforces <b>step-up</b> (a stolen 15-minute access token must not silently mint a
 * <em>permanent</em> license, SF11), and delegates to the {@link LicenseIssuerPort} - which, local or
 * remote, re-verifies entitlement/settlement/slot itself.
 */
@RestController
@ConditionalOnProperty(name = "hydropark.api.enabled", havingValue = "true")
public class LicenseController {

  static final String STEP_UP_HEADER = "X-Step-Up-Token";

  private final LicenseIssuerPort issuer;
  private final StepUpPort stepUp;
  private final LicenseQueryService query;

  public LicenseController(LicenseIssuerPort issuer, StepUpPort stepUp, LicenseQueryService query) {
    this.issuer = issuer;
    this.stepUp = stepUp;
    this.query = query;
  }

  /**
   * Body {@code {skill_id, device_id}}. Issuance is <b>naturally idempotent</b> and takes <b>no</b>
   * {@code Idempotency-Key}: a re-issue for a {@code (user, skill, device)} that already has an
   * {@code active} license returns that existing token rather than minting a second. The guarantee is
   * the partial-unique index on {@code licenses (user_id, skill_id, device_id) WHERE status='active'}
   * (the Issuer returns the existing/winning active row - see {@code LocalLicenseIssuer.issue}), not a
   * stored key. We therefore do not accept an idempotency header we would only ignore; a client that
   * sends one anyway is unaffected (it is neither required nor consumed). See docs/LICENSE-FORMAT.md.
   */
  @PostMapping("/v1/licenses/issue")
  public IssueResponse issue(
      @Valid @RequestBody IssueRequest body, HttpServletRequest request) {
    String userId = CurrentUser.requireUserId();

    // Step-up gate for a permanent effect. Absent/invalid -> STEP_UP_REQUIRED (403).
    stepUp.assertStepUp(userId, request.getHeader(STEP_UP_HEADER), Ports.StepUpActions.LICENSE_ISSUE);

    // The Issuer binds the mint to (userId=token.sub, deviceId) and confirms device.user_id == sub
    // via DeviceSlotPort.assertActiveSlot(userId, deviceId); it never trusts a device the caller
    // does not own. Natural idempotency: an existing active license for (user, skill, device) is
    // returned rather than a second being minted.
    IssuedLicense lic = issuer.issue(userId, body.skillId(), body.deviceId());
    return new IssueResponse(lic.licenseId(), lic.token(), lic.kid());
  }

  /** Cursor-paginated issued-license metadata for the current user; optional {@code device_id} filter. */
  @GetMapping("/v1/licenses")
  public CursorPage<LicenseMetadata> list(
      @RequestParam(required = false) String cursor,
      @RequestParam(required = false) Integer limit,
      @RequestParam(value = "device_id", required = false) String deviceId) {
    return query.listLicenses(CurrentUser.requireUserId(), deviceId, cursor, limit);
  }

  public record IssueRequest(
      @JsonProperty("skill_id") @NotBlank String skillId,
      @JsonProperty("device_id") @NotBlank String deviceId) {}

  public record IssueResponse(
      @JsonProperty("license_id") String licenseId,
      @JsonProperty("token") String token,
      @JsonProperty("kid") String kid) {}
}
