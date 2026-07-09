package io.hydropark.catalog.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import io.hydropark.common.Money;

/**
 * BE §4.2 - one row of {@code GET /catalog}: skills and bundles merged into a single
 * cursor-paginated feed, discriminated by {@link #kind()}.
 *
 * <p>{@code category}/{@code requirements}/{@code size}/{@code currentVersion} are {@code null} for
 * bundle rows - a bundle has no single current version, category or device requirement of its own.
 * {@code owned} is {@code null} for anonymous callers (never {@code false}) so clients can tell
 * "not authenticated" apart from "authenticated and not owned".
 */
public record CatalogItemDto(
    /** {@code "skill"} or {@code "bundle"}. */
    String kind,
    String id,
    String name,
    String category,
    Money price,
    @JsonProperty("is_free") boolean isFree,
    RequirementsDto requirements,
    Long size,
    @JsonProperty("current_version") String currentVersion,
    Boolean owned) {}
