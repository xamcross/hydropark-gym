package io.hydropark.licensing;

import java.time.Instant;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

/**
 * Append-only signer audit (BACKEND-DESIGN §6.2). Every sign - user issuance and rolling-key
 * re-issue alike - writes one row: a signing oracle abused would show up here as a per-{@code sub}
 * spike, and the row also feeds the DB-backed issuance rate limiter.
 *
 * <p>Never updated, never deleted. {@code caller} distinguishes a user-driven
 * {@code licenses.issue} from a server-driven {@code reissue-rolling-key} so the per-user rate limit
 * doesn't count maintenance re-signs against the user.
 */
@Document(collection = "license_audit")
public class LicenseAudit {

  @Id private String id;

  @Field("license_id")
  private String licenseId;

  @Field("kid")
  private String kid;

  @Field("caller")
  private String caller;

  @Field("sub")
  private String sub;

  @Field("skill_id")
  private String skillId;

  @Field("device_id")
  private String deviceId;

  @Field("at")
  private Instant at;

  public LicenseAudit() {}

  public static LicenseAudit of(
      String id,
      String licenseId,
      String kid,
      String caller,
      String sub,
      String skillId,
      String deviceId,
      Instant at) {
    LicenseAudit a = new LicenseAudit();
    a.id = id;
    a.licenseId = licenseId;
    a.kid = kid;
    a.caller = caller;
    a.sub = sub;
    a.skillId = skillId;
    a.deviceId = deviceId;
    a.at = at;
    return a;
  }

  public String getId() {
    return id;
  }

  public String getLicenseId() {
    return licenseId;
  }

  public String getKid() {
    return kid;
  }

  public String getCaller() {
    return caller;
  }

  public String getSub() {
    return sub;
  }

  public String getSkillId() {
    return skillId;
  }

  public String getDeviceId() {
    return deviceId;
  }

  public Instant getAt() {
    return at;
  }
}
