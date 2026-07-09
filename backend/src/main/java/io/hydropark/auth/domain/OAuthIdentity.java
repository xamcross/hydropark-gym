package io.hydropark.auth.domain;

import java.time.Instant;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

/**
 * BACKEND-DESIGN §3.1. A verified provider subject bound to a local user. Uniqueness on
 * {@code (provider, provider_sub)} is enforced by a migration index; find-or-create keys on that
 * pair only - never on email (SF6: no auto-merge into a local account by unverified email).
 */
@Document(collection = "oauth_identities")
public class OAuthIdentity {

  public static final String PROVIDER_GOOGLE = "google";
  public static final String PROVIDER_APPLE = "apple";

  @Id private String id;

  @Field("user_id")
  private String userId;

  @Field("provider")
  private String provider;

  @Field("provider_sub")
  private String providerSub;

  @Field("created_at")
  private Instant createdAt;

  protected OAuthIdentity() {}

  public OAuthIdentity(String id, String userId, String provider, String providerSub, Instant now) {
    this.id = id;
    this.userId = userId;
    this.provider = provider;
    this.providerSub = providerSub;
    this.createdAt = now;
  }

  public String getId() {
    return id;
  }

  public String getUserId() {
    return userId;
  }

  public String getProvider() {
    return provider;
  }

  public String getProviderSub() {
    return providerSub;
  }

  public Instant getCreatedAt() {
    return createdAt;
  }
}
