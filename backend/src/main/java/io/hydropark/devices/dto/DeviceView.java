package io.hydropark.devices.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import io.hydropark.devices.Device;
import java.time.Instant;

/**
 * BE §4.6 - the client-facing device slot: {@code {id, name, last_seen_at, status}}. Deliberately
 * <b>omits {@code fingerprint}</b>: it is coarse, server-side-only, and never leaves the backend
 * (§3.4, §13.12).
 */
public record DeviceView(
    String id,
    String name,
    String status,
    @JsonProperty("last_seen_at") Instant lastSeenAt,
    @JsonProperty("created_at") Instant createdAt) {

  public static DeviceView of(Device d) {
    return new DeviceView(d.getId(), d.getName(), d.getStatus(), d.getLastSeenAt(), d.getCreatedAt());
  }
}
