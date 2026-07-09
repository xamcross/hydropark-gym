package io.hydropark.commerce;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * §4.3 {@code POST /v1/orders/pay-wallet} body. Deliberately carries <b>no price</b>: the settlement
 * worker is the sole price authority (§5.4 Q1). Only {@code (kind, target_id, region)} are forwarded.
 */
public record PayWalletRequest(
    @JsonProperty("kind") String kind,
    @JsonProperty("target_id") String targetId,
    @JsonProperty("region") String region) {}
