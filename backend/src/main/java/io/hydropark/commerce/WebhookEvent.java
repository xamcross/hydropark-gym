package io.hydropark.commerce;

import java.time.Instant;
import java.util.Map;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

/**
 * §3.3 {@code webhook_events}. The public edge stores the <b>verbatim raw bytes</b> plus headers
 * here with status {@code received} and holds no secret (§4.8, N3). The internal settlement worker
 * later verifies the HMAC over {@link #rawBody} (constant-time, pre-parse), then claims
 * {@link #providerEventId} - whose <b>unique index is the insert-first dedupe</b> that guarantees a
 * redelivered event grants at most once (B2/B6).
 *
 * <p>{@code _id} here is an intake UUID, NOT the provider event id: at capture time the row has not
 * been parsed, so {@code providerEventId} is absent and is filled (uniquely) only by the worker. A
 * partial-unique index on {@code provider_event_id} makes a second delivery's claim fail with a
 * duplicate-key error, which is the dedupe short-circuit.
 */
@Document(collection = "webhook_events")
public class WebhookEvent {

  @Id private String id;

  @Field("provider")
  private String provider;

  /** The exact inbound bytes - never re-encoded; the HMAC is computed over these. */
  @Field("raw_body")
  private byte[] rawBody;

  /** Inbound headers, keys lowercased. Carries the provider signature header. */
  @Field("headers")
  private Map<String, String> headers;

  /** The MoR's unique event id. Absent until the worker parses; then globally unique. */
  @Field("provider_event_id")
  private String providerEventId;

  /** Our correlated order id (echoed {@code custom_data}); set by the worker. */
  @Field("order_id")
  private String orderId;

  /** Normalized event type; set by the worker. */
  @Field("type")
  private String type;

  /** {@link WebhookEventStatus#wire()}. */
  @Field("status")
  private String status;

  @Field("attempts")
  private int attempts;

  @Field("last_error")
  private String lastError;

  @Field("received_at")
  private Instant receivedAt;

  @Field("processing_at")
  private Instant processingAt;

  @Field("processed_at")
  private Instant processedAt;

  protected WebhookEvent() {}

  /** Edge-capture constructor: raw bytes + headers, status received, nothing parsed yet. */
  public WebhookEvent(String id, String provider, byte[] rawBody, Map<String, String> headers, Instant now) {
    this.id = id;
    this.provider = provider;
    this.rawBody = rawBody;
    this.headers = headers;
    this.status = WebhookEventStatus.RECEIVED.wire();
    this.attempts = 0;
    this.receivedAt = now;
  }

  public String getId() {
    return id;
  }

  public String getProvider() {
    return provider;
  }

  public byte[] getRawBody() {
    return rawBody;
  }

  public Map<String, String> getHeaders() {
    return headers;
  }

  public String getProviderEventId() {
    return providerEventId;
  }

  public String getOrderId() {
    return orderId;
  }

  public String getType() {
    return type;
  }

  public String getStatus() {
    return status;
  }

  public int getAttempts() {
    return attempts;
  }

  public String getLastError() {
    return lastError;
  }

  public Instant getReceivedAt() {
    return receivedAt;
  }
}
