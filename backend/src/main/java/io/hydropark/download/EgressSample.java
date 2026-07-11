package io.hydropark.download;

import java.time.Instant;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

/**
 * One served-object egress sample (P1-19.4). Rows here sum, per window, into the CDN bytes the
 * gross-margin gate weighs against revenue. {@code user_id} is null for public model pulls.
 */
@Document(collection = "cdn_egress")
public class EgressSample {

  @Id private String id;

  /** The buyer for a skill pull; null for the public, unauthenticated model download. */
  @Field("user_id")
  private String userId;

  /** {@code skill} | {@code model}. */
  @Field("object_type")
  private String objectType;

  @Field("object_key")
  private String objectKey;

  @Field("bytes")
  private long bytes;

  @Field("served_at")
  private Instant servedAt;

  public EgressSample() {}

  public static EgressSample create(
      String id, String userId, String objectType, String objectKey, long bytes, Instant servedAt) {
    EgressSample s = new EgressSample();
    s.id = id;
    s.userId = userId;
    s.objectType = objectType;
    s.objectKey = objectKey;
    s.bytes = bytes;
    s.servedAt = servedAt;
    return s;
  }

  public String getId() {
    return id;
  }

  public String getUserId() {
    return userId;
  }

  public String getObjectType() {
    return objectType;
  }

  public String getObjectKey() {
    return objectKey;
  }

  public long getBytes() {
    return bytes;
  }

  public Instant getServedAt() {
    return servedAt;
  }
}
