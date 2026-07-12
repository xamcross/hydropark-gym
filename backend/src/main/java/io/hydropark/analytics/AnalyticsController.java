package io.hydropark.analytics;

import io.hydropark.analytics.AnalyticsRollupService.RollupResult;
import io.hydropark.analytics.CacLtvService.CacLtvReport;
import io.hydropark.analytics.GrossMarginService.GrossMarginResult;
import io.hydropark.analytics.Phase1To2GateService.Phase1To2GateResult;
import io.hydropark.common.ApiException;
import io.hydropark.common.ErrorCode;
import io.hydropark.registry.RegistryProperties;
import io.hydropark.security.CurrentUser;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * P1-25 - the ADMIN-gated business-metrics surface (SPEC §25/§26.2): rollups, the gross-margin kill
 * gate, CAC/LTV by channel, and the Phase-1→2 go/no-go gate.
 *
 * <p><b>Not a public client route.</b> {@code SecurityConfig} keeps {@code GET /v1/admin/**}
 * {@code .authenticated()} (a valid access token, never public); because that alone would admit
 * <em>any</em> logged-in user, this controller <b>reuses the registry admin gate</b> - the caller's
 * {@code users.id} must appear in {@link RegistryProperties#getAdminUserIds()
 * hydropark.registry.admin-user-ids}, or the request is rejected with {@code 403 forbidden}. The
 * allowlist defaults to empty, so the endpoints are locked down until an operator names admins.
 */
@RestController
@RequestMapping("/v1/admin/analytics")
@ConditionalOnProperty(name = "hydropark.api.enabled", havingValue = "true", matchIfMissing = true)
public class AnalyticsController {

  private final AnalyticsQueryService analytics;
  private final RegistryProperties admins;

  public AnalyticsController(AnalyticsQueryService analytics, RegistryProperties admins) {
    this.analytics = analytics;
    this.admins = admins;
  }

  @GetMapping("/overview")
  public RollupResult overview() {
    requireAdmin();
    return analytics.overview();
  }

  @GetMapping("/margin")
  public GrossMarginResult margin() {
    requireAdmin();
    return analytics.margin();
  }

  @GetMapping("/ltv")
  public CacLtvReport ltv() {
    requireAdmin();
    return analytics.ltv();
  }

  @GetMapping("/phase-gate")
  public Phase1To2GateResult phaseGate() {
    requireAdmin();
    return analytics.phaseGate();
  }

  /**
   * The filter chain only guarantees an authenticated caller; business analytics is an admin/operator
   * view, so require the caller be on the config-driven allowlist. Empty allowlist = locked down.
   */
  private void requireAdmin() {
    String userId = CurrentUser.requireUserId();
    if (!admins.isAdmin(userId)) {
      throw new ApiException(
          ErrorCode.FORBIDDEN, "analytics is restricted to registry administrators");
    }
  }
}
