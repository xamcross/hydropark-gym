package io.hydropark.commerce;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * §4.3 {@code POST /v1/orders/checkout} body. {@code amount}/{@code currency} are honoured ONLY for
 * {@code wallet_topup}; for skill/bundle the server derives the price and ignores them (SF1).
 */
public record CheckoutRequest(
    @JsonProperty("kind") String kind,
    @JsonProperty("target_id") String targetId,
    @JsonProperty("payment_source") String paymentSource,
    @JsonProperty("amount") Long amount,
    @JsonProperty("currency") String currency,
    @JsonProperty("region") String region) {}
