package io.hydropark.signing;

import java.security.PrivateKey;
import java.security.Signature;
import java.util.Map;

/**
 * The active-signing {@link Signer} (BACKLOG P1-16.8, migration option (b)): <b>ES256</b> — ECDSA
 * over NIST P-256 with SHA-256 — with in-memory JDK keys. This is the algorithm the License Issuer
 * mints new tokens under after the switch from Ed25519, chosen because cloud KMS/HSM back-ends
 * (Azure Managed HSM, AWS KMS) sign P-256 but not Ed25519 (see {@code docs/HSM-MIGRATION.md}).
 *
 * <p><b>The one non-obvious correctness point: JWS ES256 signatures are raw {@code R || S}, not
 * DER.</b> {@code Signature.getInstance("SHA256withECDSA").sign()} returns an ASN.1/DER {@code
 * SEQUENCE { INTEGER r, INTEGER s }}. JWA (RFC 7518 §3.4) requires the fixed 64-byte concatenation of
 * R and S (32 bytes each, left-zero-padded for P-256). So this signer converts DER → P1363 via
 * {@link EcdsaP1363#derToConcat} before returning; the caller base64url-encodes those exact 64 bytes
 * as the token's third segment. {@code LicenseVerifier} performs the inverse (P1363 → DER) before
 * {@code Signature.verify()}. Leaving DER on both ends would still round-trip in Java yet be an
 * invalid JWS that no standard verifier (e.g. WebCrypto) would accept — hence the golden vector.
 *
 * <p><b>ECDSA is non-deterministic</b> (random {@code k}): the same input yields a different 64-byte
 * signature each call. Unlike the Ed25519 path there is therefore no "same input → identical bytes"
 * property to assert; correctness is proven by sign→verify round-trips and tamper-rejection.
 *
 * <p>Like {@link JdkEd25519Signer} this holds raw private material in process memory (the interim
 * custody, §11.2 #1). A cloud-KMS variant would implement this same {@link Signer} seam, calling the
 * KMS {@code Sign} API instead of the local {@code Signature} object; the token format and this DER↔
 * P1363 discipline are identical either way. Not a Spring bean itself — wired by {@code
 * io.hydropark.licensing.SignerConfig}.
 */
public final class Es256Signer implements Signer {

  private static final String JCA_ALGORITHM = "SHA256withECDSA";

  private final SigningKeyRef activeKey;
  private final Map<String, PrivateKey> privateKeysByKid;

  /**
   * @param activeKey the active key's id + public half (its {@code kid} MUST also be present in
   *     {@code privateKeysByKid}, since this signer must be able to sign under it). The public half
   *     must be a P-256 key.
   * @param privateKeysByKid every kid whose EC P-256 private half this zone holds → its {@code
   *     PrivateKey}
   */
  public Es256Signer(SigningKeyRef activeKey, Map<String, PrivateKey> privateKeysByKid) {
    if (activeKey == null) {
      throw new IllegalArgumentException("activeKey is required");
    }
    this.activeKey = activeKey;
    this.privateKeysByKid = Map.copyOf(privateKeysByKid);
  }

  @Override
  public String jwsAlg() {
    return "ES256";
  }

  @Override
  public SigningKeyRef activeKey() {
    return activeKey;
  }

  @Override
  public byte[] sign(byte[] signingInput, SigningKeyRef key) {
    PrivateKey pk = privateKeysByKid.get(key.kid());
    if (pk == null) {
      // Never include key material in the message.
      throw new IllegalStateException("no in-memory private key for kid=" + key.kid());
    }
    try {
      Signature s = Signature.getInstance(JCA_ALGORITHM);
      s.initSign(pk);
      s.update(signingInput);
      byte[] der = s.sign(); // ASN.1/DER SEQUENCE{ INTEGER r, INTEGER s }
      // JWS ES256 wants fixed 64-byte R||S, NOT DER. Convert, or the token is not a valid JWS.
      return EcdsaP1363.derToConcat(der, EcdsaP1363.P256_COORD_BYTES);
    } catch (Exception e) {
      throw new IllegalStateException("ES256 license signing failed for kid=" + key.kid(), e);
    }
  }
}
