package io.hydropark.catalog;

import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

/**
 * BE §3.2. {@code id} is a UUIDv7 ({@link io.hydropark.common.Uuid7}). Unique on {@code
 * (skill_id, version)}; unique partial on {@code (skill_id) WHERE is_current} - both indexes are
 * created by a migration (semver isn't sortable, so {@code is_current} is what resolves "latest").
 * This package only reads/writes through those invariants; it does not create the indexes.
 */
@Document(collection = "skill_versions")
public class SkillVersion {

  @Id private String id;

  @Field("skill_id")
  private String skillId;

  /** Semver. */
  @Field("version")
  private String version;

  @Field("is_current")
  private boolean current;

  @Field("min_app_version")
  private String minAppVersion;

  /** Object-store key for the signed {@code .hpskill}. Never returned to clients directly. */
  @Field("package_uri")
  private String packageUri;

  @Field("package_sha256")
  private String packageSha256;

  @Field("package_bytes")
  private long packageBytes;

  /** Ed25519 signature over the package (§8.8). Never returned to clients directly. */
  @Field("signature")
  private String signature;

  @Field("signing_key_id")
  private String signingKeyId;

  @Field("changelog")
  private String changelog;

  /** {@link CatalogStatus#wire()} value. */
  @Field("status")
  private String status;

  public SkillVersion() {}

  public String getId() {
    return id;
  }

  public void setId(String id) {
    this.id = id;
  }

  public String getSkillId() {
    return skillId;
  }

  public void setSkillId(String skillId) {
    this.skillId = skillId;
  }

  public String getVersion() {
    return version;
  }

  public void setVersion(String version) {
    this.version = version;
  }

  public boolean isCurrent() {
    return current;
  }

  public void setCurrent(boolean current) {
    this.current = current;
  }

  public String getMinAppVersion() {
    return minAppVersion;
  }

  public void setMinAppVersion(String minAppVersion) {
    this.minAppVersion = minAppVersion;
  }

  public String getPackageUri() {
    return packageUri;
  }

  public void setPackageUri(String packageUri) {
    this.packageUri = packageUri;
  }

  public String getPackageSha256() {
    return packageSha256;
  }

  public void setPackageSha256(String packageSha256) {
    this.packageSha256 = packageSha256;
  }

  public long getPackageBytes() {
    return packageBytes;
  }

  public void setPackageBytes(long packageBytes) {
    this.packageBytes = packageBytes;
  }

  public String getSignature() {
    return signature;
  }

  public void setSignature(String signature) {
    this.signature = signature;
  }

  public String getSigningKeyId() {
    return signingKeyId;
  }

  public void setSigningKeyId(String signingKeyId) {
    this.signingKeyId = signingKeyId;
  }

  public String getChangelog() {
    return changelog;
  }

  public void setChangelog(String changelog) {
    this.changelog = changelog;
  }

  public String getStatus() {
    return status;
  }

  public void setStatus(String status) {
    this.status = status;
  }
}
