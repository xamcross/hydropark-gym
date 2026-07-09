package io.hydropark.auth.domain;

import java.time.Instant;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

/**
 * BACKEND-DESIGN §8 (SF11/N8). A single-use, short-TTL out-of-band step-up challenge. The
 * {@code challenge_hash} is the SHA-256 of the secret the client must present as the
 * {@code X-Step-Up-Token}; only the hash is stored. Bound to a specific {@code action} so a proof
 * minted for one perpetual effect cannot be replayed against another. Consumed by stamping
 * {@code consumed_at} atomically.
 */
@Document(collection = "step_up_challenges")
public class StepUpChallenge {

  @Id private String id;

  @Field("user_id")
  private String userId;

  @Field("action")
  private String action;

  @Field("challenge_hash")
  private String challengeHash;

  @Field("expires_at")
  private Instant expiresAt;

  @Field("consumed_at")
  private Instant consumedAt;

  @Field("created_at")
  private Instant createdAt;

  protected StepUpChallenge() {}

  public StepUpChallenge(
      String id, String userId, String action, String challengeHash, Instant expiresAt, Instant now) {
    this.id = id;
    this.userId = userId;
    this.action = action;
    this.challengeHash = challengeHash;
    this.expiresAt = expiresAt;
    this.consumedAt = null;
    this.createdAt = now;
  }

  public String getId() {
    return id;
  }

  public String getUserId() {
    return userId;
  }

  public String getAction() {
    return action;
  }

  public String getChallengeHash() {
    return challengeHash;
  }

  public Instant getExpiresAt() {
    return expiresAt;
  }

  public Instant getConsumedAt() {
    return consumedAt;
  }
}
