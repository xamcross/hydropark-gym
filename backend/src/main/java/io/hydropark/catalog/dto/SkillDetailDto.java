package io.hydropark.catalog.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import io.hydropark.common.Money;
import java.util.List;

/**
 * BE §4.2 SF8 - {@code GET /catalog/skills/{id}}.
 *
 * <p><b>Carries {@link #compressedPrompt()} only, never the full {@code system_prompt}</b> - that
 * field does not exist anywhere in this package (see {@link io.hydropark.catalog.Skill}) and never
 * will. {@link #hasPreview()} tells the client whether {@code GET
 * /catalog/skills/{id}/preview} has anything to return, without leaking the curated transcript URI
 * itself outside that extraction-hardened endpoint.
 *
 * <p>{@code media} and a {@code panels}/{@code tools} summary are named in BACKEND-DESIGN §4.2 as
 * part of this response, but the exact {@code skills} schema this package was built against (see
 * AGENT-CONTRACT) has no backing fields for either - they are omitted here rather than invented.
 * See the final report for this gap.
 *
 * <p>{@link #capabilities()} (F05) is the manifest's top-level capability-token array (e.g.
 * {@code ["timers","unit_conversion","list_management"]}) - the install-time capability-disclosure
 * source (SPEC §8.5/§11). It is never empty-vs-null ambiguous: {@link
 * io.hydropark.catalog.CatalogService#getSkillDetail} always supplies a non-null (possibly empty)
 * list.
 */
public record SkillDetailDto(
    String id,
    String name,
    String category,
    @JsonProperty("is_free") boolean isFree,
    String status,
    Money price,
    @JsonProperty("compressed_prompt") String compressedPrompt,
    @JsonProperty("has_preview") boolean hasPreview,
    @JsonProperty("min_model_tier") String minModelTier,
    RequirementsDto requirements,
    @JsonProperty("current_version") SkillVersionDto currentVersion,
    String changelog,
    Boolean owned,
    List<String> capabilities) {}
