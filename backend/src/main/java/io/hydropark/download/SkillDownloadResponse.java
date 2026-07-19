package io.hydropark.download;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.time.Instant;

/**
 * P1-19.2 response for {@code GET /v1/download/skills/{skillId}/{version}}: the short-TTL, user-scoped
 * signed URL, when it expires, and the buyer {@code watermark} embedded in the delivered package.
 */
public record SkillDownloadResponse(
    String url, @JsonProperty("expires_at") Instant expiresAt, String watermark) {}
