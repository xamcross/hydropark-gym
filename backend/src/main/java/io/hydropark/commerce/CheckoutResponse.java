package io.hydropark.commerce;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.List;

/**
 * §4.3 checkout response. For a MoR purchase: {@code checkout_url} is set. For a wallet-funded
 * skill/bundle (routed to pay-wallet): {@code owned} carries the granted skill ids and there is no
 * checkout URL.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record CheckoutResponse(
    @JsonProperty("order_id") String orderId,
    @JsonProperty("checkout_url") String checkoutUrl,
    @JsonProperty("owned") List<String> owned) {}
