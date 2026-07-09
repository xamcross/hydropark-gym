package io.hydropark.catalog.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * BE §4.2 - {@code GET /catalog/skills/{id}/versions} row shape, and the {@code current_version}
 * embedded in skill detail. Deliberately excludes {@code package_uri}, {@code signature} and {@code
 * signing_key_id}: those are download/verification internals resolved by {@code
 * /download/skills/{id}/{version}} (BE §4.5), not catalog metadata.
 */
public record SkillVersionDto(
    String version,
    @JsonProperty("min_app_version") String minAppVersion,
    /** {@code package_bytes}. */
    Long size,
    @JsonProperty("sha256") String packageSha256,
    @JsonProperty("is_current") boolean current,
    String changelog,
    String status) {}
