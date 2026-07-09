package io.hydropark.licensing;

import java.time.Instant;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

/**
 * Issuance log: one row per per-device license token minted (BACKEND-DESIGN §3.3/§13.11). The
 * {@code _id} is the {@code license_id} carried in the token.
 *
 * <p>A partial unique index on {@code (user_id, skill_id, device_id) WHERE status='active'} keeps at
 * most one <em>live</em> license per {@code (skill, device)}; re-issue under a newer key marks the
 * old row {@code superseded} and inserts a fresh {@code active} one (§6.3). The stored {@code token}
 * is an audit copy - the authoritative artifact lives on the device.
 */
@Document(collection = "licenses")
public class License {

  @Id private String id;

  @Field("user_id")
  private String userId;

  @Field("skill_id")
  private String skillId;

  @Field("device_id")
  private String deviceId;

  /** Which issuer key signed this token - the {@code kid} in the JWS header. */
  @Field("signing_key_id")
  private String signingKeyId;

  @Field("token")
  private String token;

  /** {@code active} | {@code superseded}. */
  @Field("status")
  private String status;

  @Field("issued_at")
  private Instant issuedAt;

  public License() {}

  public static License active(
      String id,
      String userId,
      String skillId,
      String deviceId,
      String signingKeyId,
      String token,
      Instant issuedAt) {
    License l = new License();
    l.id = id;
    l.userId = userId;
    l.skillId = skillId;
    l.deviceId = deviceId;
    l.signingKeyId = signingKeyId;
    l.token = token;
    l.status = "active";
    l.issuedAt = issuedAt;
    return l;
  }

  public String getId() {
    return id;
  }

  public String getUserId() {
    return userId;
  }

  public String getSkillId() {
    return skillId;
  }

  public String getDeviceId() {
    return deviceId;
  }

  public String getSigningKeyId() {
    return signingKeyId;
  }

  public String getToken() {
    return token;
  }

  public String getStatus() {
    return status;
  }

  public Instant getIssuedAt() {
    return issuedAt;
  }
}
