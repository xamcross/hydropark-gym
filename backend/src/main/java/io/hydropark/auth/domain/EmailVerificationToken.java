package io.hydropark.auth.domain;

import java.time.Instant;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

/**
 * BACKEND-DESIGN §3.6. Short-TTL email-verification token. The reference schema keys this table on
 * {@code token_hash} itself (PRIMARY KEY), so the SHA-256 hash is stored as {@code _id}: lookup by
 * hash needs no extra index and uniqueness is the built-in {@code _id} guarantee. The plaintext token
 * is emailed once and never stored. Expiry is also asserted in the service layer, not left solely to
 * a TTL index.
 */
@Document(collection = "email_verification_tokens")
public class EmailVerificationToken {

  @Id private String tokenHash;

  @Field("user_id")
  private String userId;

  @Field("expires_at")
  private Instant expiresAt;

  @Field("created_at")
  private Instant createdAt;

  protected EmailVerificationToken() {}

  public EmailVerificationToken(String tokenHash, String userId, Instant expiresAt, Instant now) {
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
