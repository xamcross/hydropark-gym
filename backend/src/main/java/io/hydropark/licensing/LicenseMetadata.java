package io.hydropark.licensing;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.time.Instant;

/**
 * Issued-license metadata for {@code GET /v1/licenses} (BACKEND-DESIGN §4.4). The account portal
 * lists these per device. It <b>never</b> includes the token - the token is the credential and lives
 * only on the device it was minted for.
 */
public record LicenseMetadata(
    @JsonProperty("license_id") String licenseId,
    @JsonProperty("skill_id") String skillId,
    @JsonProperty("device_id") String deviceId,
    @JsonProperty("kid") String kid,
    @JsonProperty("status") String status,
    @JsonProperty("issued_at") Instant issuedAt) {

  static LicenseMetadata of(License l) {
    return new LicenseMetadata(
        l.getId(), l.getSkillId(), l.getDeviceId(), l.getSigningKeyId(), l.getStatus(), l.getIssuedAt());
  }
}
