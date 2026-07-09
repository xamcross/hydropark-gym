package io.hydropark.auth.service;

/**
 * A freshly minted pair: the short-lived access JWT and the opaque refresh-token plaintext. The
 * refresh plaintext is returned to the caller exactly once; only its hash is persisted.
 */
public record AuthTokens(String accessJwt, String refreshToken) {}
