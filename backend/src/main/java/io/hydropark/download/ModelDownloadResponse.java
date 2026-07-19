package io.hydropark.download;

import com.fasterxml.jackson.annotation.JsonProperty;
import java.time.Instant;

/**
 * P1-19.3 response for {@code GET /v1/download/models/{modelId}}: a free, shared-scope (cacheable)
 * signed URL and its expiry. No watermark - the base model is not paid IP.
 */
public record ModelDownloadResponse(String url, @JsonProperty("expires_at") Instant expiresAt) {}
