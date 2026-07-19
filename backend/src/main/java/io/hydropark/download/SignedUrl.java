package io.hydropark.download;

import java.time.Instant;

/**
 * A short-lived signed download URL: the fully-formed URL a client fetches, plus the instant it
 * stops being valid. The signature/expiry are embedded in {@link #url()} - {@link #expiresAt()} is
 * surfaced separately so the API can return it (§ P1-19.2 {@code expires_at}) without the client
 * having to parse the query string.
 */
public record SignedUrl(String url, Instant expiresAt) {}
