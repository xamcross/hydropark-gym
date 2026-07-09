package io.hydropark.catalog.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import io.hydropark.common.Money;
import java.util.List;

/**
 * BE §4.2 - {@code GET /catalog/bundles/{id}}: members plus bundle price vs the sum of member
 * prices, both resolved through the same regional pricing ({@link
 * io.hydropark.catalog.PricingPortImpl}) that a purchase would use, so the "savings" figure shown
 * matches what checkout would actually charge for the given region.
 */
public record BundleDetailDto(
    String id,
    String name,
    String status,
    @JsonProperty("bundle_price") Money bundlePrice,
    @JsonProperty("member_price_sum") Money memberPriceSum,
    Money savings,
    List<BundleMemberDto> members,
    Boolean owned) {}
