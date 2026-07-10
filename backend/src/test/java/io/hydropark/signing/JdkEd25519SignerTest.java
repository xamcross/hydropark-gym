package io.hydropark.signing;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PrivateKey;
import java.security.Signature;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * The extracted crypto seam. Proves the JDK signer produces a genuine, tamper-evident Ed25519
 * signature over the exact bytes handed to it, is deterministic (so a refactor can never silently
 * change a token's bytes), and surfaces the active key. This is the raw-signature counterpart to the
 * end-to-end round-trip in {@code licensing.LicenseCryptoTest}. Pure JUnit — no Spring, no Mongo.
 */
class JdkEd25519SignerTest {

  private static KeyPair ed25519() throws Exception {
    return KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
  }

  private static boolean verify(java.security.PublicKey pub, byte[] input, byte[] sig)
      throws Exception {
    Signature s = Signature.getInstance("Ed25519");
    s.initVerify(pub);
    s.update(input);
    return s.verify(sig);
  }

  @Test
  void signsOverExactBytesAndVerifies() throws Exception {
    KeyPair kp = ed25519();
    SigningKeyRef ref = new SigningKeyRef("hp-lic-test", kp.getPublic());
    Signer signer =
        new JdkEd25519Signer(ref, Map.of("hp-lic-test", (PrivateKey) kp.getPrivate()));

    byte[] input = "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1XzEifQ".getBytes(StandardCharsets.US_ASCII);
    byte[] sig = signer.sign(input, ref);

    assertThat(verify(kp.getPublic(), input, sig)).isTrue();
    assertThat(signer.activeKey()).isEqualTo(ref);
  }

  @Test
  void aFlippedInputByteFailsVerification() throws Exception {
    KeyPair kp = ed25519();
    SigningKeyRef ref = new SigningKeyRef("hp-lic-test", kp.getPublic());
    Signer signer =
        new JdkEd25519Signer(ref, Map.of("hp-lic-test", (PrivateKey) kp.getPrivate()));

    byte[] input = "the-exact-signing-input".getBytes(StandardCharsets.US_ASCII);
    byte[] sig = signer.sign(input, ref);

    byte[] tampered = input.clone();
    tampered[0] ^= 0x01; // flip one bit
    assertThat(verify(kp.getPublic(), tampered, sig)).isFalse();
  }

  @Test
  void signingIsDeterministicSoTokenBytesNeverDriftAcrossARefactor() throws Exception {
    KeyPair kp = ed25519();
    SigningKeyRef ref = new SigningKeyRef("hp-lic-test", kp.getPublic());
    Signer signer =
        new JdkEd25519Signer(ref, Map.of("hp-lic-test", (PrivateKey) kp.getPrivate()));

    byte[] input = "same-bytes-same-key".getBytes(StandardCharsets.US_ASCII);
    // Ed25519 is deterministic: same key + same message => byte-identical signature. This is exactly
    // the property that lets the seam be a drop-in replacement for the old inline signing.
    assertThat(signer.sign(input, ref)).isEqualTo(signer.sign(input, ref));
  }

  @Test
  void anUnknownKidHasNoInMemoryPrivateKeyAndFails() throws Exception {
    KeyPair kp = ed25519();
    SigningKeyRef known = new SigningKeyRef("hp-lic-A", kp.getPublic());
    Signer signer = new JdkEd25519Signer(known, Map.of("hp-lic-A", (PrivateKey) kp.getPrivate()));

    SigningKeyRef unknown = new SigningKeyRef("hp-lic-B", kp.getPublic());
    assertThatThrownBy(() -> signer.sign("x".getBytes(StandardCharsets.US_ASCII), unknown))
        .isInstanceOf(IllegalStateException.class)
        .hasMessageContaining("hp-lic-B");
  }
}
