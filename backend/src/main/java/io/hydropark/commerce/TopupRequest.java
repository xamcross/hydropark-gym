package io.hydropark.commerce;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * §4.7 {@code POST /v1/wallet/topup} body. {@code amount} (minor units) is authoritative - a top-up
 * is the single {@code wallet_topup} exception to server-derived pricing (SF1); it is validated, not
 * derived. {@code currency} is optional: it must match the wallet's fixed currency when one exists,
 * and sets it on the first top-up. The endpoint lives in {@code commerce} (not {@code wallet})
 * because a top-up is an order that needs a {@link PaymentProvider} checkout session.
 */
public record TopupRequest(
    @JsonProperty("amount") Long amount,
    @JsonProperty("currency") String currency,
    @JsonProperty("region") String region) {}
