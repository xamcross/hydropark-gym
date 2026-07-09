package io.hydropark.catalog.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import io.hydropark.common.Money;

public record BundleMemberDto(
    @JsonProperty("skill_id") String skillId, String name, String category, Money price) {}
