package io.hydropark.auth.domain;

import java.time.Instant;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

/**
 * BACKEND-DESIGN §3.6. Single-use, short-TTL password-reset token. As with
 * {@link EmailVerificationToken}, the SHA-256 hash is the {@code _id} (reference schema keys the
 * table on {@code token_hash}); only the hash is stored. Single-use is enforced by deleting the row
 * on successful reset, and expiry is checked in the service layer.
 */
@Document(collection = "password_reset_tokens")
public class PasswordResetToken {

  @Id private String tokenHash;

  @Field("user_id")
  private String userId;

  @Field("expires_at")
  private Instant expiresAt;

  @Field("created_at")
  private Instant createdAt;

  protected PasswordResetToken() {}

  public PasswordResetToken(String tokenHash, String userId, Instant expiresAt, Instant now) {
    this.tokenHash = tokenHash;
    this.userId = userId;
    this.expiresAt = expiresAt;
    this.createdAt = now;
  }

  public String getTokenHash() {
    return tokenHash;
  }

  public String getUserId() {
    return userId;
  }

  public Instant getExpiresAt() {
    return expiresAt;
  }
}
