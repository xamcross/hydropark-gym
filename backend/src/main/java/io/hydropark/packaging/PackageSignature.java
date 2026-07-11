package io.hydropark.packaging;

/**
 * The two registry-applied manifest fields produced by {@link PackageSigner} (schema {@code
 * signature} / {@code signing_key_id}). {@code signature} is the wire value written verbatim into the
 * manifest: the {@code ed25519:} algorithm prefix followed by the base64 raw signature (matching the
 * schema pattern {@code ^ed25519:[A-Za-z0-9+/=_-]+$}). {@code signingKeyId} names the package-signing
 * key — a key class distinct from the license-signing key (SPEC §13.8, §8.8).
 */
public record PackageSignature(String signature, String signingKeyId) {}
