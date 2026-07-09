package io.hydropark.licensing;

/**
 * The internal zone-crossing request body for {@code POST /internal/licenses/issue}. Both ends of
 * this hop are ours, so it stays camelCase (no wire-compat concern). The Issuer re-verifies the
 * {@code (user, skill)} settlement itself, so this carrying a {@code userId} is not a trust grant -
 * a caller cannot make the Issuer sign an unowned skill by supplying an arbitrary user here.
 */
public record InternalIssueRequest(String userId, String skillId, String deviceId) {}
