package io.hydropark.devices;

import java.time.Instant;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

/**
 * BE §3.4. A device is a nameable, manageable <em>slot</em> (SPEC §13.4/§13.6); max 5 active per
 * user. The {@code _id} is the {@code device_id} embedded in signed license payloads.
 *
 * <p>{@link #fingerprint} is <b>coarse and server-side only</b>: it is never re-derived offline and
 * never returned to the client (BE §3.4, §13.12). The Issuer reads it via {@link
 * DeviceSlotPortImpl#fingerprintOf} to embed as the license {@code device_binding}. A unique index
 * on {@code (user_id, fingerprint)} is what makes register <b>match-or-create</b> - a reinstall or
 * OS move reclaims its slot rather than burning a new one (B4).
 */
@Document(collection = "devices")
public class Device {

  /** {@link #status} values. Stored as their lowercase wire string, per BE §3.4. */
  public static final String ACTIVE = "active";

  public static final String DEAUTHORIZED = "deauthorized";

  public static final String DEFAULT_NAME = "My device";

  @Id private String id;

  @Field("user_id")
  private String userId;

  @Field("name")
  private String name;

  /** Coarse, server-side only. Never re-derived offline, never serialized to the client (§13.12). */
  @Field("fingerprint")
  private String fingerprint;

  @Field("status")
  private String status;

  @Field("last_seen_at")
  private Instant lastSeenAt;

  @Field("created_at")
  private Instant createdAt;

  public Device() {}

  public Device(
      String id,
      String userId,
      String name,
      String fingerprint,
      String status,
      Instant lastSeenAt,
      Instant createdAt) {
    this.id = id;
    this.userId = userId;
    this.name = name;
    this.fingerprint = fingerprint;
    this.status = status;
    this.lastSeenAt = lastSeenAt;
    this.createdAt = createdAt;
  }

  public boolean isActive() {
    return ACTIVE.equals(status);
  }

  public String getId() {
    return id;
  }

  public void setId(String id) {
    this.id = id;
  }

  public String getUserId() {
    return userId;
  }

  public void setUserId(String userId) {
    this.userId = userId;
  }

  public String getName() {
    return name;
  }

  public void setName(String name) {
    this.name = name;
  }

  public String getFingerprint() {
    return fingerprint;
  }

  public void setFingerprint(String fingerprint) {
    this.fingerprint = fingerprint;
  }

  public String getStatus() {
    return status;
  }

  public void setStatus(String status) {
    this.status = status;
  }

  public Instant getLastSeenAt() {
    return lastSeenAt;
  }

  public void setLastSeenAt(Instant lastSeenAt) {
    this.lastSeenAt = lastSeenAt;
  }

  public Instant getCreatedAt() {
    return createdAt;
  }

  public void setCreatedAt(Instant createdAt) {
    this.createdAt = createdAt;
  }
}
