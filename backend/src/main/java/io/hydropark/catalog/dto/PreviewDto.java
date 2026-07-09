package io.hydropark.catalog.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * BE §4.2 N1 / SPEC §11.4 - the curated, pre-rendered demo transcript for a skill's try-before-buy
 * preview. Never contains live-generated output over client input; see {@link
 * io.hydropark.catalog.CatalogService#getPreview(String)}.
 */
public record PreviewDto(@JsonProperty("preview_transcript_uri") String previewTranscriptUri) {}
