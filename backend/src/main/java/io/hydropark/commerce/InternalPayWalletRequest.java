package io.hydropark.commerce;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Body of the zone-crossing call {@code POST /internal/settlement/pay-wallet} (§5.4). Carries the
 * forwarded {@code (user, kind, target, region)} and the client's idempotency key - and, by design,
 * <b>no price</b>. The worker derives the amount itself.
 */
public record InternalPayWalletRequest(
    @JsonProperty("user_id") String userId,
    @JsonProperty("kind") String kind,
    @JsonProperty("target_id") String targetId,
    @JsonProperty("region") String region,
    @JsonProperty("idempotency_key") String idempotencyKey) {}
