package io.hydropark.signing;

import java.security.PublicKey;

/**
 * A reference to a signing key: its {@code kid} and its <b>public</b> half — and deliberately
 * <b>not</b> its private half.
 *
 * <p>This is the whole reason the {@link Signer} seam exists. In the interim JDK custody
 * (BACKEND-DESIGN §11.2 #1) the private half is an in-memory {@code PrivateKey} the JDK signer holds;
 * under a hardware HSM (YubiHSM 2, Luna, nShield) the private half <em>never leaves the device</em>
 * and is addressed only by a PKCS#11 label/handle. Both worlds still need the same two public facts —
 * which {@code kid} is signing, and the public key the client ships in its trusted-key set (§6.3) —
 * so those, and only those, live here. A key reference must never be able to leak private material,
 * because it is passed around freely.
 */
public record SigningKeyRef(String kid, PublicKey publicKey) {

  public SigningKeyRef {
    if (kid == null || kid.isBlank()) {
      throw new IllegalArgumentException("SigningKeyRef requires a non-blank kid");
    }
  }
}
