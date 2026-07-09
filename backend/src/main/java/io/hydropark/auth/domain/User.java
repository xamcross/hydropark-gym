package io.hydropark.auth.domain;

import java.time.Instant;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

/**
 * BACKEND-DESIGN §3.1. Email is optional (§12/§22.5) - a device-only user may have none, and OAuth-
 * only / device-only accounts carry a null {@code password_hash}. Case-insensitive email uniqueness
 * is enforced by a collation unique index created in a migration (§11.1); we additionally normalise
 * the stored value to lower-case so a plain equality lookup finds the row without a collation query.
 *
 * <p>{@code has_ever_had_device} is the trust-root anchor for step-up (§8, SF11/N8): trust-on-first-
 * use is granted only for the genuinely first device an account ever binds, <em>not</em> whenever the
 * account currently has zero active devices - otherwise an attacker could deauthorise every device
 * and TOFU a rogue one.
 */
@Document(collection = "users")
public class User {

  public static final String STATUS_ACTIVE = "active";
  public static final String STATUS_DELETION_PENDING = "deletion_pending";
  public static final String STATUS_DELETED = "deleted";

  @Id private String id;

  /** Nullable, normalised to lower-case. Unique (case-insensitive) via a migration collation index. */
  @Field("email")
  private String email;

  @Field("email_verified")
  private boolean emailVerified;

  /** Nullable: device-only and OAuth-only accounts have no password. */
  @Field("password_hash")
  private String passwordHash;

  /**
   * SHA-256 of a one-time recovery code shown once at registration to pure device-only accounts
   * (§8 N8). It is the out-of-band step-up factor for accounts that have neither a verified email nor
   * an OAuth identity. Only the hash is ever stored.
   */
  @Field("recovery_code_hash")
  private String recoveryCodeHash;

  /** active | deletion_pending | deleted. */
  @Field("status")
  private String status = STATUS_ACTIVE;

  @Field("deletion_requested_at")
  private Instant deletionRequestedAt;

  /** GDPR job handle (§8). The job status is tracked in-place rather than in a separate collection. */
  @Field("deletion_job_id")
  private String deletionJobId;

  @Field("deletion_status")
  private String deletionStatus;

  @Field("deletion_completed_at")
  private Instant deletionCompletedAt;

  @Field("has_ever_had_device")
  private boolean hasEverHadDevice;

  @Field("created_at")
  private Instant createdAt;

  @Field("updated_at")
  private Instant updatedAt;

  protected User() {}

  public User(String id, String email, String passwordHash, String recoveryCodeHash, Instant now) {
    this.id = id;
    this.email = email;
    this.passwordHash = passwordHash;
    this.recoveryCodeHash = recoveryCodeHash;
    this.status = STATUS_ACTIVE;
    this.emailVerified = false;
    this.hasEverHadDevice = false;
    this.createdAt = now;
    this.updatedAt = now;
  }

  public String getId() {
    return id;
  }

  public String getEmail() {
    return email;
  }

  public void setEmail(String email) {
    this.email = email;
  }

  public boolean isEmailVerified() {
    return emailVerified;
  }

  public void setEmailVerified(boolean emailVerified) {
    this.emailVerified = emailVerified;
  }

  public String getPasswordHash() {
    return passwordHash;
  }

  public void setPasswordHash(String passwordHash) {
    this.passwordHash = passwordHash;
  }

  public String getRecoveryCodeHash() {
    return recoveryCodeHash;
  }

  public void setRecoveryCodeHash(String recoveryCodeHash) {
    this.recoveryCodeHash = recoveryCodeHash;
  }

  public String getStatus() {
    return status;
  }

  public void setStatus(String status) {
    this.status = status;
  }

  public Instant getDeletionRequestedAt() {
    return deletionRequestedAt;
  }

  public void setDeletionRequestedAt(Instant deletionRequestedAt) {
    this.deletionRequestedAt = deletionRequestedAt;
  }

  public String getDeletionJobId() {
    return deletionJobId;
  }

  public void setDeletionJobId(String deletionJobId) {
    this.deletionJobId = deletionJobId;
  }

  public String getDeletionStatus() {
    return deletionStatus;
  }

  public void setDeletionStatus(String deletionStatus) {
    this.deletionStatus = deletionStatus;
  }

  public Instant getDeletionCompletedAt() {
    return deletionCompletedAt;
  }

  public void setDeletionCompletedAt(Instant deletionCompletedAt) {
    this.deletionCompletedAt = deletionCompletedAt;
  }

  public boolean isHasEverHadDevice() {
    return hasEverHadDevice;
  }

  public void setHasEverHadDevice(boolean hasEverHadDevice) {
    this.hasEverHadDevice = hasEverHadDevice;
  }

  public Instant getCreatedAt() {
    return createdAt;
  }

  public Instant getUpdatedAt() {
    return updatedAt;
  }

  public void setUpdatedAt(Instant updatedAt) {
    this.updatedAt = updatedAt;
  }
}
