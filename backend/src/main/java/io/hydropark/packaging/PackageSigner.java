package io.hydropark.packaging;

import com.fasterxml.jackson.databind.JsonNode;
import io.hydropark.signing.Signer;
import io.hydropark.signing.SigningKeyRef;
import java.util.Base64;

/**
 * Signs a {@code .hpskill} manifest with the <b>package-signing</b> key (SPEC §8.8, BACKEND-DESIGN
 * §6.2 B8). Canonicalizes the manifest with {@code signature} + {@code signing_key_id} excluded (see
 * {@link ManifestCanonicalizer}), signs those bytes via an {@link io.hydropark.signing.Signer}, and
 * returns the two fields the registry writes back into the manifest.
 *
 * <p><b>Key class separation.</b> This reuses the {@code io.hydropark.signing.Signer} seam but is
 * always constructed with a package key — never the license signer. It is deliberately <em>not</em>
 * exposed as a bare {@code Signer} bean (that would collide with the licensing {@code activeSigner}
 * and could turn the license signer into a package oracle); {@code PackageSignerConfig} builds it from
 * the {@link PackageTrustedKeySet} instead.
 *
 * <p><b>Algorithm: Ed25519.</b> Justification: (1) the published contract already pins it — the skill
 * manifest schema declares {@code signature} as {@code ^ed25519:...} and calls out the "skill-package
 * key class, distinct from the license-signing key". (2) The license path switched to ES256 only
 * because cloud KMS/HSM cannot sign Ed25519; package signing runs with in-process registry keys and
 * has no such constraint. (3) Ed25519 is deterministic, so the same manifest always yields the same
 * signature — a useful property for a repeatable packaging step. The signature wire form is {@code
 * ed25519:} + standard base64 of the raw 64-byte signature.
 */
public final class PackageSigner {

  /** The algorithm prefix on the manifest {@code signature} field (schema {@code ^ed25519:...}). */
  static final String ALG_PREFIX = "ed25519:";

  private static final Base64.Encoder B64 = Base64.getEncoder();

  private final Signer signer;

  /**
   * @param signer an Ed25519 signer holding the <b>package</b> key (never the license key)
   * @throws IllegalArgumentException if the signer is not Ed25519
   */
  public PackageSigner(Signer signer) {
    if (signer == null) {
      throw new IllegalArgumentException("package signer is required");
    }
    if (!"EdDSA".equals(signer.jwsAlg())) {
      throw new IllegalArgumentException(
          "package signing requires an Ed25519 (EdDSA) signer, got alg=" + signer.jwsAlg());
    }
    this.signer = signer;
  }

  /** Produce the {@code signature} + {@code signing_key_id} for {@code manifest}. */
  public PackageSignature sign(JsonNode manifest) {
    SigningKeyRef key = signer.activeKey();
    byte[] canonical = ManifestCanonicalizer.canonicalBytes(manifest);
    byte[] raw = signer.sign(canonical, key);
    return new PackageSignature(ALG_PREFIX + B64.encodeToString(raw), key.kid());
  }
}
