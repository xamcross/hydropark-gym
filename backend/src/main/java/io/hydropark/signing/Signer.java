package io.hydropark.signing;

/**
 * The signing seam (BACKLOG P1-16.8). Everything about a license token — the header/payload shape,
 * the base64url encoding, the exact {@code base64url(header) || '.' || base64url(payload)} signing
 * input, the token assembly — lives in {@code io.hydropark.licensing.LicenseSigner} and is
 * signer-independent. The <em>only</em> thing that differs between "Ed25519 key in process memory"
 * and "Ed25519 key in a hardware HSM" is <b>who computes the raw signature over those exact bytes</b>.
 * That difference — and nothing else — is this interface.
 *
 * <p>Isolating it here means an HSM/KMS backend is a new {@link Signer} implementation plus config,
 * not a redesign of the token format or the offline verifier. See {@code docs/HSM-MIGRATION.md} for
 * the migration decision and why no cloud KMS can implement this for Ed25519 today.
 *
 * <p>Implementations:
 *
 * <ul>
 *   <li>{@link Es256Signer} — the <b>active-signing</b> path: ECDSA P-256 + SHA-256 (P1-16.8). New
 *       license tokens are minted under this after the Ed25519→ES256 switch.
 *   <li>{@link JdkEd25519Signer} — the extracted in-memory JDK-native Ed25519 path (P1-16.3), now
 *       retained for verifying <b>older</b> Ed25519-signed licenses during the dual-algorithm window.
 *   <li>{@link Pkcs11Ed25519Signer} — the gated hardware-HSM skeleton (YubiHSM 2 / Luna / nShield).
 * </ul>
 */
public interface Signer {

  /**
   * The <b>raw signature</b> over exactly {@code signingInput}, produced under {@code key}, in the
   * JWS wire form for this signer's algorithm. The bytes in are the bytes signed — no re-encoding, no
   * canonicalization (§6.1). The bytes out are the raw signature the caller base64url-encodes as the
   * token's third segment:
   *
   * <ul>
   *   <li>{@code EdDSA} (Ed25519): the raw 64-byte Ed25519 signature, deterministic for a given key
   *       and message.
   *   <li>{@code ES256} (ECDSA P-256): the fixed 64-byte {@code R || S} (IEEE P1363 / RFC 7518 §3.4),
   *       <b>not</b> ASN.1/DER — the implementation converts. ECDSA is non-deterministic, so this
   *       differs on every call for the same input.
   * </ul>
   *
   * <p>An HSM implementation returns the value of its {@code C_Sign} call (converting DER→P1363 for
   * ECDSA if the token returns DER).
   */
  byte[] sign(byte[] signingInput, SigningKeyRef key);

  /**
   * The JWS {@code alg} this signer stamps into the header: {@code ES256} or {@code EdDSA}. The
   * verifier never trusts this header value to <em>select</em> an algorithm — it pins the algorithm
   * per {@code kid} from the trusted-key set and asserts the header matches — but the signer must
   * emit the correct one for the active key.
   */
  String jwsAlg();

  /**
   * The current active signing key: its {@code kid} (stamped into the JWS header) and its public
   * half (shipped in the client trusted-key set, §6.3). This is how the caller learns which key to
   * name and publish without ever touching private material.
   */
  SigningKeyRef activeKey();
}
