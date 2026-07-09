package io.hydropark.licensing;

/**
 * The decoded license JWS payload (BACKEND-DESIGN §6.1). This is a <em>parsed view</em>, produced
 * only <b>after</b> the signature has verified over the exact received bytes - it is never
 * re-serialized and re-signed. {@code exp} is {@code null} (perpetual); verification is signature +
 * field checks, never a clock. {@code maxDevices} is advisory - the real cap is enforced at
 * issuance.
 */
public record LicensePayload(
    String licenseId,
    String sub,
    String skillId,
    String versionConstraint,
    String entitlement,
    String deviceId,
    String deviceBinding,
    int maxDevices,
    long iat,
    Long exp,
    String iss) {}
