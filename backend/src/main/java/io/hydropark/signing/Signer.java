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
 *   <li>{@link JdkEd25519Signer} — the default; the extracted in-memory JDK-native path (P1-16.3).
 *   <li>{@link Pkcs11Ed25519Signer} — the gated hardware-HSM skeleton (YubiHSM 2 / Luna / nShield).
 * </ul>
 */
public interface Signer {

  /**
   * The <b>raw detached Ed25519 signature</b> over exactly {@code signingInput}, produced under
   * {@code key}. The bytes in are the bytes signed — no re-encoding, no canonicalization (§6.1). The
   * bytes out are the raw signature the caller base64url-encodes as the token's third segment.
   *
   * <p>An HSM implementation returns the value of its {@code C_Sign} call verbatim; because Ed25519
   * is deterministic, a given key over given input yields identical bytes regardless of which
   * implementation computed them.
   */
  byte[] sign(byte[] signingInput, SigningKeyRef key);

  /**
   * The current active signing key: its {@code kid} (stamped into the JWS header) and its public
   * half (shipped in the client trusted-key set, §6.3). This is how the caller learns which key to
   * name and publish without ever touching private material.
   */
  SigningKeyRef activeKey();
}
