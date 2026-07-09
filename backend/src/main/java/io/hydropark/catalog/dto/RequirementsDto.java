package io.hydropark.catalog.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

/** BE §4.2 - device/model requirements shown on catalog list and skill detail. */
public record RequirementsDto(
    @JsonProperty("min_model_tier") String minModelTier,
    @JsonProperty("min_app_version") String minAppVersion) {}
