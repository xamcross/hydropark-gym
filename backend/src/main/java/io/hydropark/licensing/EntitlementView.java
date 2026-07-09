package io.hydropark.licensing;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * One row of {@code GET /v1/entitlements} (BACKEND-DESIGN §4.4). {@code status} is
 * {@code owned} when the skill is effectively owned (&ge;1 active grant); otherwise it is the
 * <b>most-recent terminal status</b> ({@code refunded} / {@code charged_back} / {@code revoked}) so
 * the client can tell "revoked" apart from "never owned" and disable + reinstall-block accordingly.
 */
public record EntitlementView(
    @JsonProperty("skill_id") String skillId, @JsonProperty("status") String status) {

  public static final String OWNED = "owned";
}
