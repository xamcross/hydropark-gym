package io.hydropark.download;

import java.time.Instant;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

/**
 * A watermark buyer-token, written once per issued paid-skill download (P1-19.2). It ties a specific
 * {@code (user, skill, version)} pull to a {@link #watermarkToken} embedded in the delivered package,
 * so a leaked {@code .hpskill} can be traced back to the buyer.
 *
 * <p>This collection is a subject-data store keyed on {@code user_id}, so it is in scope for the GDPR
 * erasure scrub (P1-12.6): deleting a user's rows here removes the linkage between them and any copies
 * they downloaded.
 */
@Document(collection = "download_records")
public class DownloadRecord {

  @Id private String id;

  @Field("user_id")
  private String userId;

  @Field("skill_id")
  private String skillId;

  @Field("version")
  private String version;

  /** {@code HMAC(user | skill | version)} - deterministic per buyer+version, unguessable, traceable. */
  @Field("watermark_token")
  private String watermarkToken;

  @Field("issued_at")
  private Instant issuedAt;

  public DownloadRecord() {}

  public static DownloadRecord create(
      String id,
      String userId,
      String skillId,
      String version,
      String watermarkToken,
      Instant issuedAt) {
    DownloadRecord r = new DownloadRecord();
    r.id = id;
    r.userId = userId;
    r.skillId = skillId;
    r.version = version;
    r.watermarkToken = watermarkToken;
    r.issuedAt = issuedAt;
    return r;
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

  public String getVersion() {
    return version;
  }

  public String getWatermarkToken() {
    return watermarkToken;
  }

  public Instant getIssuedAt() {
    return issuedAt;
  }
}
