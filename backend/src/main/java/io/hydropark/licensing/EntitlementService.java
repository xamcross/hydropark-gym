package io.hydropark.licensing;

import io.hydropark.port.Ports.GrantStatus;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Service;

/**
 * Derives per-skill entitlement status straight from {@code grants} (BACKEND-DESIGN §4.4, §5.3) -
 * there is no stored entitlement row to drift out of sync. A skill is {@code owned} while &ge;1
 * grant is active; once fully unowned we surface the most-recent terminal status so the client
 * distinguishes a revocation from a skill it never bought.
 */
@Service
public class EntitlementService {

  private final GrantRepository grants;

  public EntitlementService(GrantRepository grants) {
    this.grants = grants;
  }

  public List<EntitlementView> forUser(String userId) {
    // Preserve first-seen order for stable output.
    Map<String, List<Grant>> bySkill = new LinkedHashMap<>();
    for (Grant g : grants.findByUserId(userId)) {
      bySkill.computeIfAbsent(g.getSkillId(), k -> new ArrayList<>()).add(g);
    }

    List<EntitlementView> out = new ArrayList<>();
    for (Map.Entry<String, List<Grant>> e : bySkill.entrySet()) {
      out.add(new EntitlementView(e.getKey(), statusFor(e.getValue())));
    }
    return out;
  }

  private static String statusFor(List<Grant> skillGrants) {
    boolean owned =
        skillGrants.stream().anyMatch(g -> GrantStatus.ACTIVE.wire().equals(g.getStatus()));
    if (owned) {
      return EntitlementView.OWNED;
    }
    // Most-recent terminal grant wins - by revocation time, falling back to grant time.
    return skillGrants.stream()
        .max(Comparator.comparing(EntitlementService::recencyKey))
        .map(Grant::getStatus)
        .orElse(EntitlementView.OWNED);
  }

  private static Instant recencyKey(Grant g) {
    return g.getRevokedAt() != null ? g.getRevokedAt() : g.getGrantedAt();
  }
}
