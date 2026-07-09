package io.hydropark.commerce;

import java.time.Instant;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

/**
 * §3.6 {@code idempotency_keys} (Appendix A). Scoped per {@code (user_id, endpoint, key)} so distinct
 * legitimate calls are not collapsed and same-key retries are. The first response (status + body) is
 * stored and replayed verbatim on repeat, so a retried mutating call never double-charges/grants.
 *
 * <p>The composite {@code (user_id, endpoint, key)} is folded into {@code _id}, so the placeholder
 * insert is itself the claim - a concurrent duplicate collides on {@code _id} rather than racing a
 * read-then-write. Rows carry {@code expires_at} (~24h) for a TTL index to reap (see report).
 */
@Document(collection = "idempotency_keys")
public class IdempotencyRecord {

  /** {@code user_id + '|' + endpoint + '|' + key}. */
  @Id private String id;

  @Field("user_id")
  private String userId;

  @Field("endpoint")
  private String endpoint;

  @Field("key")
  private String key;

  @Field("completed")
  private boolean completed;

  @Field("response_status")
  private Integer responseStatus;

  /** The stored response body (JSON object), replayed verbatim. */
  @Field("response_body")
  private Object responseBody;

  @Field("created_at")
  private Instant createdAt;

  @Field("expires_at")
  private Instant expiresAt;

  protected IdempotencyRecord() {}

  /** In-flight placeholder: claims the key before the action runs. */
  public IdempotencyRecord(String userId, String endpoint, String key, Instant now, Instant expiresAt) {
    this.id = compositeId(userId, endpoint, key);
    this.userId = userId;
    this.endpoint = endpoint;
    this.key = key;
    this.completed = false;
    this.createdAt = now;
    this.expiresAt = expiresAt;
  }

  public static String compositeId(String userId, String endpoint, String key) {
    return userId + "|" + endpoint + "|" + key;
  }

  public String getId() {
    return id;
  }

  public boolean isCompleted() {
    return completed;
  }

  public Integer getResponseStatus() {
    return responseStatus;
  }

  public Object getResponseBody() {
    return responseBody;
  }
}
