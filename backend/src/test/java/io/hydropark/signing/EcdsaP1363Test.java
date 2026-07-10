package io.hydropark.signing;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.util.Arrays;
import org.junit.jupiter.api.Test;

/**
 * Directly exercises the DER &harr; P1363 ({@code R||S}) conversion that turns the JDK's DER ECDSA
 * output into the fixed 64-byte JWS ES256 signature and back. This is the single most error-prone
 * part of ES256; the round-trip below drives it against real {@code SHA256withECDSA} signatures,
 * including — across many iterations — the awkward cases where a coordinate needs a DER sign byte
 * (high bit set) or is short (leading zeros), which fixed-width padding must handle.
 */
class EcdsaP1363Test {

  private static KeyPair p256() throws Exception {
    KeyPairGenerator g = KeyPairGenerator.getInstance("EC");
    g.initialize(new ECGenParameterSpec("secp256r1"));
    return g.generateKeyPair();
  }

  @Test
  void derToConcatIsAlways64BytesAndConcatToDerVerifiesAgainstTheJdk() throws Exception {
    KeyPair kp = p256();

    for (int i = 0; i < 200; i++) {
      byte[] msg = ("message-" + i).getBytes(StandardCharsets.US_ASCII);

      Signature signer = Signature.getInstance("SHA256withECDSA");
      signer.initSign(kp.getPrivate());
      signer.update(msg);
      byte[] der = signer.sign();

      byte[] concat = EcdsaP1363.derToConcat(der, EcdsaP1363.P256_COORD_BYTES);
      assertThat(concat).as("iteration " + i + " raw length").hasSize(64);

      // Reconstruct DER from R||S and verify with the JDK — proves the conversion is lossless and
      // the resulting DER is well-formed for SHA256withECDSA.
      byte[] rebuiltDer = EcdsaP1363.concatToDer(concat);
      Signature verifier = Signature.getInstance("SHA256withECDSA");
      verifier.initVerify(kp.getPublic());
      verifier.update(msg);
      assertThat(verifier.verify(rebuiltDer)).as("iteration " + i + " verifies").isTrue();

      // Round-trip is idempotent: DER -> concat -> DER -> concat yields the same 64 bytes.
      assertThat(EcdsaP1363.derToConcat(rebuiltDer, 32)).isEqualTo(concat);
    }
  }

  @Test
  void concatToDerRejectsMalformedInput() {
    assertThatThrownBy(() -> EcdsaP1363.concatToDer(new byte[63]))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> EcdsaP1363.concatToDer(new byte[0]))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> EcdsaP1363.concatToDer(null))
        .isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void derToConcatRejectsNonSequence() {
    byte[] notDer = {0x02, 0x01, 0x00}; // an INTEGER, not a SEQUENCE
    assertThatThrownBy(() -> EcdsaP1363.derToConcat(notDer, 32))
        .isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void concatToDerPrependsSignByteWhenTopBitSet() {
    // A coordinate whose top byte is 0xFF must become a DER INTEGER with a leading 0x00 (positive).
    byte[] concat = new byte[64];
    Arrays.fill(concat, 0, 32, (byte) 0xFF); // R = 0xFFFF...FF
    concat[32] = 0x01; // S = 1
    byte[] der = EcdsaP1363.concatToDer(concat);
    // SEQUENCE { INTEGER(0x00 || 32*0xFF) , INTEGER(0x01) }
    // R content is 33 bytes (sign byte + 32), so its INTEGER is 0x02 0x21 0x00 FF...
    assertThat(der[0]).isEqualTo((byte) 0x30);
    assertThat(der[2]).isEqualTo((byte) 0x02); // first INTEGER tag
    assertThat(der[3]).isEqualTo((byte) 0x21); // length 33
    assertThat(der[4]).isEqualTo((byte) 0x00); // the added sign byte
  }
}
