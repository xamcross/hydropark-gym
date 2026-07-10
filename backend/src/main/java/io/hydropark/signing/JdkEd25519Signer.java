package io.hydropark.signing;

import java.security.PrivateKey;
import java.security.Signature;
import java.util.Map;

/**
 * The default {@link Signer}: the interim in-memory JDK-native Ed25519 path (BACKEND-DESIGN §11.2 #1,
 * P1-16.3). This is the crypto <b>extracted verbatim</b> from the old inline {@code
 * LicenseSigner.ed25519Sign} — same {@code Signature.getInstance("Ed25519")}, same {@code initSign /
 * update / sign} — so a token minted through this signer is byte-for-byte identical to what the old
 * inline code produced. Nothing about the token format changed; only the call site moved behind the
 * seam.
 *
 * <p>The private keys are Ed25519 {@code PrivateKey} objects the issuer zone parsed from its Fly
 * encrypted secrets (via {@code TrustedKeySet}) and passed in at wiring time. Because this signer
 * holds raw private material in process memory, a compromised issuer host yields the key — the
 * documented downgrade this whole seam exists to eventually retire (see {@code docs/HSM-MIGRATION.md}).
 *
 * <p>Not a Spring bean itself: it is wired by {@code io.hydropark.licensing.SignerConfig}, which is
 * the one place allowed to bridge the licensing {@code TrustedKeySet} to this package.
 */
public final class JdkEd25519Signer implements Signer {

  private final SigningKeyRef activeKey;
  private final Map<String, PrivateKey> privateKeysByKid;

  /**
   * @param activeKey the active key's id + public half (its {@code kid} MUST also be present in
   *     {@code privateKeysByKid}, since this signer must be able to sign under it)
   * @param privateKeysByKid every kid whose private half this zone holds → its {@code PrivateKey}
   */
  public JdkEd25519Signer(SigningKeyRef activeKey, Map<String, PrivateKey> privateKeysByKid) {
    if (activeKey == null) {
      throw new IllegalArgumentException("activeKey is required");
    }
    this.activeKey = activeKey;
    this.privateKeysByKid = Map.copyOf(privateKeysByKid);
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
      Signature s = Signature.getInstance("Ed25519");
      s.initSign(pk);
      s.update(signingInput);
      return s.sign();
    } catch (Exception e) {
      throw new IllegalStateException("license signing failed for kid=" + key.kid(), e);
    }
  }
}
