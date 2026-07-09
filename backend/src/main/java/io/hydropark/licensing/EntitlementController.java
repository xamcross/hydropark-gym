package io.hydropark.licensing;

import io.hydropark.security.CurrentUser;
import java.util.List;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * {@code GET /v1/entitlements} (BACKEND-DESIGN §4.4) - the list the client refreshes on every online
 * launch. Each entry is {@code {skill_id, status}}, derived live from {@code grants}; revocations
 * surface here on the device's next online contact. Returned whole (not paginated): the client wants
 * the full picture each launch.
 */
@RestController
@ConditionalOnProperty(name = "hydropark.api.enabled", havingValue = "true")
public class EntitlementController {

  private final EntitlementService entitlements;

  public EntitlementController(EntitlementService entitlements) {
    this.entitlements = entitlements;
  }

  @GetMapping("/v1/entitlements")
  public List<EntitlementView> list() {
    return entitlements.forUser(CurrentUser.requireUserId());
  }
}
