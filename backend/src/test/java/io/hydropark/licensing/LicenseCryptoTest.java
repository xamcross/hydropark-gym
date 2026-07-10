package io.hydropark.licensing;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.hydropark.config.AppProperties;
import io.hydropark.licensing.LicensingTestKeys.KeyMaterial;
import io.hydropark.signing.Signer;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * The signer/verifier round-trip and its tamper-evidence for <b>ES256</b> (ECDSA P-256) — the
 * property the whole offline licensing model rests on after the Ed25519→ES256 switch (P1-16.8). Plus
 * the two ES256-specific correctness proofs the ticket demands:
 *
 * <ul>
 *   <li>the JWS signature is the fixed 64-byte {@code R||S} (not variable-length DER);
 *   <li>the algorithm is pinned per {@code kid} and header/kid alg-confusion is rejected <b>fail-closed</b>;
 *   <li>a single trusted set verifies <b>both</b> a new ES256 license and an older EdDSA one.
 * </ul>
 *
 * <p>Pure JUnit: no Spring, no Mongo, freshly generated keypairs. (Independent WebCrypto-style
 * cross-verification of a golden vector lives in {@link Es256GoldenVectorTest}.)
 */
class LicenseCryptoTest {

  private static final Base64.Decoder B64URL = Base64.getUrlDecoder();
  private static final Base64.Encoder B64URL_ENC = Base64.getUrlEncoder().withoutPadding();
  private final ObjectMapper json = new ObjectMapper();

  private LicenseSigner signerFor(AppProperties props) {
    return new LicenseSigner(SignerConfig.signerFrom(new TrustedKeySet(props)), props);
  }

  private LicenseVerifier verifierFor(AppProperties props) {
    return new LicenseVerifier(new TrustedKeySet(props), props);
  }

  @Test
  void es256SignThenVerifyRoundTrips() {
    AppProperties props = LicensingTestKeys.propsWithFreshKey("hp-lic-test");
    LicenseSigner signer = signerFor(props);
    LicenseVerifier verifier = verifierFor(props);

    LicenseSigner.Signed signed =
        signer.sign("lic_round", "user_123", "cooking-assistant", "dev_ab12", "fp-coarse");

    LicensePayload p = verifier.verify(signed.token());

    assertThat(signed.token().split("\\.")).hasSize(3);
    assertThat(signed.kid()).isEqualTo("hp-lic-test");
    assertThat(p.licenseId()).isEqualTo("lic_round");
    assertThat(p.sub()).isEqualTo("user_123");
    assertThat(p.skillId()).isEqualTo("cooking-assistant");
    assertThat(p.deviceId()).isEqualTo("dev_ab12");
    assertThat(p.deviceBinding()).isEqualTo("fp-coarse");
    assertThat(p.entitlement()).isEqualTo("perpetual");
    assertThat(p.exp()).isNull();
    assertThat(p.iss()).isEqualTo("hydropark-licensing");
    assertThat(p.maxDevices()).isEqualTo(5);
  }

  @Test
  void theHeaderAlgIsEs256() throws Exception {
    AppProperties props = LicensingTestKeys.propsWithFreshKey("hp-lic-test");
    String token =
        signerFor(props).sign("lic_h", "u", "s", "d", "fp").token();
    var header = json.readTree(B64URL.decode(token.split("\\.")[0]));
    assertThat(header.get("alg").asText()).isEqualTo("ES256");
    assertThat(header.get("typ").asText()).isEqualTo("hp-lic+jws");
  }

  @Test
  void theEs256SignatureIsExactly64BytesRawRsNotDer() {
    // ES256 JWS signatures are the fixed 64-byte P1363 R||S (RFC 7518 §3.4). DER would be ~70-72 and
    // variable-length. Asserting exactly 64 is the on-the-wire proof the DER->R||S conversion ran.
    AppProperties props = LicensingTestKeys.propsWithFreshKey("hp-lic-test");
    for (int i = 0; i < 8; i++) { // ECDSA is randomized; check several signatures
      String token = signerFor(props).sign("lic_" + i, "u", "s", "d", "fp").token();
      byte[] sig = B64URL.decode(token.split("\\.")[2]);
      assertThat(sig).as("ES256 signature length").hasSize(64);
    }
  }

  @Test
  void ecdsaIsNonDeterministicSoTwoSignaturesOverTheSameInputDiffer() {
    // The opposite of the Ed25519 determinism property: same input -> DIFFERENT bytes each time.
    AppProperties props = LicensingTestKeys.propsWithFreshKey("hp-lic-test");
    LicenseSigner signer = signerFor(props);
    String a = signer.sign("lic_same", "u", "s", "d", "fp").token().split("\\.")[2];
    String b = signer.sign("lic_same", "u", "s", "d", "fp").token().split("\\.")[2];
    assertThat(a).isNotEqualTo(b);
  }

  @Test
  void aSingleFlippedByteInThePayloadFailsVerification() {
    AppProperties props = LicensingTestKeys.propsWithFreshKey("hp-lic-test");
    LicenseSigner signer = signerFor(props);
    LicenseVerifier verifier = verifierFor(props);

    String token =
        signer.sign("lic_tamper", "user_123", "cooking-assistant", "dev_ab12", "fp").token();

    String[] parts = token.split("\\.");
    char c = parts[1].charAt(0);
    char flipped = (c == 'A') ? 'B' : 'A'; // a different valid base64url char -> different bytes
    String tamperedPayload = flipped + parts[1].substring(1);
    String tampered = parts[0] + "." + tamperedPayload + "." + parts[2];

    assertThatThrownBy(() -> verifier.verify(tampered))
        .isInstanceOf(LicenseVerificationException.class);
  }

  @Test
  void anUnknownKidIsRejected() {
    AppProperties signingProps = LicensingTestKeys.propsWithFreshKey("hp-lic-A");
    AppProperties trustingProps = LicensingTestKeys.propsWithFreshKey("hp-lic-B");

    String token = signerFor(signingProps).sign("lic_x", "u", "s", "d", "fp").token();

    assertThatThrownBy(() -> verifierFor(trustingProps).verify(token))
        .isInstanceOf(LicenseVerificationException.class);
  }

  // -----------------------------------------------------------------------------------------------
  // Alg-confusion: the verifier pins the algorithm to the kid's key record and rejects a token whose
  // header alg disagrees — even when the signature is otherwise VALID over the presented bytes. This
  // is the security-critical property, not merely "a tampered signature fails".
  // -----------------------------------------------------------------------------------------------

  @Test
  void anEs256KidPresentedWithHeaderAlgEdDSAIsRejectedFailClosed() throws Exception {
    // Trusted set knows ONE kid, an ES256 key. Forge a token for that kid whose header lies "EdDSA",
    // but sign it VALIDLY with the real ES256 key over the forged bytes. The alg-pin must still reject
    // it because header alg (EdDSA) != pinned alg (ES256) for this kid.
    KeyMaterial es = LicensingTestKeys.freshEs256("hp-lic-es");
    AppProperties props = LicensingTestKeys.propsWith(LicensingTestKeys.toSigningKey(es, true));
    Signer es256 = SignerConfig.signerFrom(new TrustedKeySet(props));

    String forged = forgeToken("EdDSA", "hp-lic-es", es256);

    assertThatThrownBy(() -> verifierFor(props).verify(forged))
        .isInstanceOf(LicenseVerificationException.class)
        .hasMessageContaining("alg mismatch");
  }

  @Test
  void anEdDsaKidPresentedWithHeaderAlgEs256IsRejectedFailClosed() throws Exception {
    // Mirror image: an EdDSA key, but the header lies "ES256". Pinned alg is EdDSA, header says ES256
    // -> reject before any signature work.
    KeyMaterial ed = LicensingTestKeys.freshEd25519("hp-lic-ed");
    AppProperties props = LicensingTestKeys.propsWith(LicensingTestKeys.toSigningKey(ed, true));
    Signer eddsa = SignerConfig.signerFrom(new TrustedKeySet(props));

    String forged = forgeToken("ES256", "hp-lic-ed", eddsa);

    assertThatThrownBy(() -> verifierFor(props).verify(forged))
        .isInstanceOf(LicenseVerificationException.class)
        .hasMessageContaining("alg mismatch");
  }

  // -----------------------------------------------------------------------------------------------
  // Dual-algorithm: a single trusted set holds an OLD EdDSA (Ed25519) verify key and a NEW ES256
  // active key, and verifies a license signed under each. This is the §6.3 no-stranding guarantee:
  // new issuance is ES256 while deployed Ed25519 licenses keep verifying.
  // -----------------------------------------------------------------------------------------------

  @Test
  void oneTrustedSetVerifiesBothANewEs256LicenseAndAnOldEdDsaLicense() {
    KeyMaterial old = LicensingTestKeys.freshEd25519("hp-lic-2025-ed");
    KeyMaterial current = LicensingTestKeys.freshEs256("hp-lic-2026-es");

    // The shipped/verify set: both kids trusted; the ES256 one is active for new signing.
    AppProperties dual =
        LicensingTestKeys.propsWith(
            LicensingTestKeys.toSigningKey(old, false), LicensingTestKeys.toSigningKey(current, true));
    LicenseVerifier verifier = new LicenseVerifier(new TrustedKeySet(dual), dual);

    // An "old" Ed25519 license: signed by an issuer whose active key was the Ed25519 one.
    AppProperties edOnly = LicensingTestKeys.propsWith(LicensingTestKeys.toSigningKey(old, true));
    LicenseSigner edSigner = signerFor(edOnly);
    LicenseSigner.Signed oldToken = edSigner.sign("lic_old", "user_9", "gardening", "dev_old", "fp1");

    // A "new" ES256 license under the current active key.
    LicenseSigner esSigner = signerFor(dual);
    LicenseSigner.Signed newToken = esSigner.sign("lic_new", "user_9", "cooking", "dev_new", "fp2");

    assertThat(oldToken.kid()).isEqualTo("hp-lic-2025-ed");
    assertThat(newToken.kid()).isEqualTo("hp-lic-2026-es");

    LicensePayload oldP = verifier.verify(oldToken.token());
    LicensePayload newP = verifier.verify(newToken.token());

    assertThat(oldP.skillId()).isEqualTo("gardening");
    assertThat(newP.skillId()).isEqualTo("cooking");
    // And they really are different algorithms on the wire.
    assertThat(headerAlg(oldToken.token())).isEqualTo("EdDSA");
    assertThat(headerAlg(newToken.token())).isEqualTo("ES256");
  }

  // ---- helpers -------------------------------------------------------------------------------

  /** Build a token with an attacker-chosen header {@code alg}, VALIDLY signed by {@code signer}. */
  private String forgeToken(String headerAlg, String kid, Signer signer) throws Exception {
    Map<String, Object> header = new LinkedHashMap<>();
    header.put("alg", headerAlg);
    header.put("kid", kid);
    header.put("typ", "hp-lic+jws");

    Map<String, Object> payload = new LinkedHashMap<>();
    payload.put("license_id", "lic_forged");
    payload.put("sub", "attacker");
    payload.put("skill_id", "cooking");
    payload.put("version_constraint", ">=1.0.0");
    payload.put("entitlement", "perpetual");
    payload.put("device_id", "dev_x");
    payload.put("device_binding", "fp");
    payload.put("max_devices", 5);
    payload.put("iat", 1_760_000_000L);
    payload.put("exp", null);
    payload.put("iss", "hydropark-licensing");

    String signingInput =
        B64URL_ENC.encodeToString(json.writeValueAsBytes(header))
            + "."
            + B64URL_ENC.encodeToString(json.writeValueAsBytes(payload));
    byte[] sig = signer.sign(signingInput.getBytes(StandardCharsets.US_ASCII), signer.activeKey());
    return signingInput + "." + B64URL_ENC.encodeToString(sig);
  }

  private String headerAlg(String token) {
    try {
      return json.readTree(B64URL.decode(token.split("\\.")[0])).get("alg").asText();
    } catch (Exception e) {
      throw new RuntimeException(e);
    }
  }
}
