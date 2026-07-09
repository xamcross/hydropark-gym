package io.hydropark.auth.domain;

import java.time.Instant;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

/**
 * BACKEND-DESIGN §3.6, §8. A rotating refresh token. Only the SHA-256 {@code token_hash} is stored;
 * the opaque plaintext is returned once and never persisted.
 *
 * <p>Reuse detection: every login opens a {@code family_id}; each use sets {@code used_at} and mints
 * a child ({@code prev_id} points back). Presenting a token whose row already has {@code used_at}
 * revokes the whole family - <em>unless</em> it is the immediately-prior token re-presented within the
 * retry-grace window (a dropped response on a flaky network must not log the user out). The
 * {@code prev_id} chain is what distinguishes "immediately-prior, within grace" from out-of-chain
 * reuse.
 */
@Document(collection = "refresh_tokens")
public class RefreshToken {

  @Id private String id;

  @Field("user_id")
  private String userId;

  @Field("family_id")
  private String familyId;

  @Field("token_hash")
  private String tokenHash;

  @Field("prev_id")
  private String prevId;

  @Field("used_at")
  private Instant usedAt;

  @Field("revoked")
  private boolean revoked;

  @Field("expires_at")
  private Instant expiresAt;

  @Field("created_at")
  private Instant createdAt;

  @Field("updated_at")
  private Instant updatedAt;

  protected RefreshToken() {}

  public RefreshToken(
      String id,
      String userId,
      String familyId,
      String tokenHash,
      String prevId,
      Instant expiresAt,
      Instant now) {
    this.id = id;
    this.userId = userId;
    this.familyId = familyId;
    this.tokenHash = tokenHash;
    this.prevId = prevId;
    this.usedAt = null;
    this.revoked = false;
    this.expiresAt = expiresAt;
    this.createdAt = now;
    this.updatedAt = now;
  }

  public String getId() {
    return id;
  }

  public String getUserId() {
    return userId;
  }

  public String getFamilyId() {
    return familyId;
  }

  public String getTokenHash() {
    return tokenHash;
  }

  public String getPrevId() {
    return prevId;
  }

  public Instant getUsedAt() {
    return usedAt;
  }

  public void setUsedAt(Instant usedAt) {
    this.usedAt = usedAt;
  }

  public boolean isRevoked() {
    return revoked;
  }

  public void setRevoked(boolean revoked) {
    this.revoked = revoked;
  }

  public Instant getExpiresAt() {
    return expiresAt;
  }

  public Instant getCreatedAt() {
    return createdAt;
  }
}
