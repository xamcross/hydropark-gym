package io.hydropark.commerce;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.time.Instant;

/** §4.3 order/receipt projection returned by {@code GET /v1/orders/{id}} and {@code GET /v1/orders}. */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record OrderView(
    @JsonProperty("order_id") String orderId,
    @JsonProperty("kind") String kind,
    @JsonProperty("target_id") String targetId,
    @JsonProperty("amount") long amount,
    @JsonProperty("currency") String currency,
    @JsonProperty("payment_source") String paymentSource,
    @JsonProperty("status") String status,
    @JsonProperty("created_at") Instant createdAt) {

  public static OrderView of(Order o) {
    return new OrderView(
        o.getId(),
        o.getKind(),
        o.getTargetId(),
        o.getAmount(),
        o.getCurrency(),
        o.getPaymentSource(),
        o.getStatus(),
        o.getCreatedAt());
  }
}
