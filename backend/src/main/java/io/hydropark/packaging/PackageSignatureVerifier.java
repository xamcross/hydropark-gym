package io.hydropark.packaging;

import com.fasterxml.jackson.databind.JsonNode;
import java.security.PublicKey;
import java.security.Signature;
import java.util.Base64;
import org.springframework.stereotype.Component;

/**
 * Verifies the detached package signature a manifest carries (SPEC §8.8) against the <b>package</b>
 * trusted-key set — a separate set from the license one. Mirrors the license verifier's discipline:
 * the {@code signing_key_id} selects the trusted public key, the algorithm is pinned to Ed25519 (the
 * package key class), and the signature covers the canonical manifest bytes with the two signature
 * fields excluded ({@link ManifestCanonicalizer}).
 *
 * <p>Every failure mode is rejected <b>explicitly</b> with a stable code, never skipped: missing
 * signature ({@code signature_missing}), missing kid ({@code signing_key_id_missing}), an algorithm
 * prefix other than {@code ed25519:} ({@code signature_alg_unsupported}), an unknown/rolled-off kid
 * ({@code unknown_signing_key}), malformed base64 ({@code signature_malformed}), and a signature that
 * does not match the manifest ({@code signature_mismatch}). Absence of a signature is a rejection, not
 * a pass — an unsigned package must not slip through.
 */
@Component
public class PackageSignatureVerifier {

  private static final Base64.Decoder B64 = Base64.getDecoder();

  private final PackageTrustedKeySet keys;

  public PackageSignatureVerifier(PackageTrustedKeySet keys) {
    this.keys = keys;
  }

  /**
   * Verify the package signature on {@code manifest}.
   *
   * @return the verified {@code signing_key_id}
   * @throws PackageSignatureException on any failure (see class doc for codes)
   */
  public String verify(JsonNode manifest) {
    if (manifest == null || !manifest.isObject()) {
      throw new PackageSignatureException("signature_missing", "manifest is not a JSON object");
    }

    JsonNode sigNode = manifest.get(ManifestCanonicalizer.SIGNATURE_FIELD);
    if (sigNode == null || !sigNode.isTextual() || sigNode.asText().isBlank()) {
      throw new PackageSignatureException(
          "signature_missing", "manifest is missing a package signature");
    }
    JsonNode kidNode = manifest.get(ManifestCanonicalizer.SIGNING_KEY_ID_FIELD);
    if (kidNode == null || !kidNode.isTextual() || kidNode.asText().isBlank()) {
      throw new PackageSignatureException(
          "signing_key_id_missing", "manifest is missing signing_key_id");
    }

    String sigWire = sigNode.asText();
    String kid = kidNode.asText();
    if (!sigWire.startsWith(PackageSigner.ALG_PREFIX)) {
      throw new PackageSignatureException(
          "signature_alg_unsupported", "package signature must be of the form ed25519:<base64>");
    }

    // Pin the key by kid from the trusted set — an unknown kid is a hard rejection.
    PublicKey pub =
        keys.verifierFor(kid)
            .orElseThrow(
                () ->
                    new PackageSignatureException(
                        "unknown_signing_key",
                        "unknown or rolled-off package signing_key_id: " + kid));

    byte[] raw;
    try {
      raw = B64.decode(sigWire.substring(PackageSigner.ALG_PREFIX.length()));
    } catch (IllegalArgumentException e) {
      throw new PackageSignatureException(
          "signature_malformed", "malformed base64 in package signature", e);
    }

    byte[] canonical = ManifestCanonicalizer.canonicalBytes(manifest);
    boolean ok;
    try {
      Signature s = Signature.getInstance("Ed25519");
      s.initVerify(pub);
      s.update(canonical);
      ok = s.verify(raw);
    } catch (Exception e) {
      throw new PackageSignatureException(
          "signature_error", "package signature verification error", e);
    }
    if (!ok) {
      throw new PackageSignatureException(
          "signature_mismatch", "package signature does not match manifest for kid " + kid);
    }
    return kid;
  }
}
