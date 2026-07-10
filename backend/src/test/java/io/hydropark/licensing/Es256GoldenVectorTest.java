package io.hydropark.licensing;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.hydropark.config.AppProperties;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Proves the committed ES256 golden vector ({@code docs/es256-golden-vector.json}, also on the test
 * classpath) is a <b>genuine JWS ES256 token</b> — a real raw {@code R||S} signature, not accidental
 * DER — via a path that is <em>independent</em> of the production signer/verifier code:
 *
 * <ol>
 *   <li>the third segment base64url-decodes to <b>exactly 64 bytes</b> (P-256 R||S; DER would be
 *       ~70-72 and variable);
 *   <li>reconstruct the P-256 public key from the committed SPKI, split the 64 bytes into R and S,
 *       build the ASN.1 DER independently with {@link BigInteger#toByteArray()} (a different code
 *       path from {@code EcdsaP1363}), and verify with {@code SHA256withECDSA} — this is exactly what
 *       WebCrypto's {@code ECDSA/P-256/SHA-256} does, so a pass here is the same proof the lead gets;
 *   <li>the production {@link LicenseVerifier} also accepts the token and decodes the expected payload.
 * </ol>
 *
 * If the signer had (wrongly) emitted DER, step 1 would fail (length != 64) and step 2 would reject.
 * Pure JUnit — no Spring, no Mongo.
 */
class Es256GoldenVectorTest {

  private static final Base64.Decoder B64URL = Base64.getUrlDecoder();
  private final ObjectMapper json = new ObjectMapper();

  private JsonNode loadGoldenVector() throws Exception {
    // The build-authoritative copy is on the test classpath; docs/es256-golden-vector.json mirrors it.
    try (InputStream in = getClass().getResourceAsStream("/licensing/es256-golden-vector.json")) {
      assertThat(in).as("golden vector on classpath").isNotNull();
      return json.readTree(in);
    }
  }

  @Test
  void theGoldenSignatureIsExactly64BytesRawRs() throws Exception {
    JsonNode gv = loadGoldenVector();
    String token = gv.get("token").asText();
    String[] parts = token.split("\\.");
    assertThat(parts).hasSize(3);
    byte[] sig = B64URL.decode(parts[2]);
    assertThat(sig).as("ES256 raw R||S signature length").hasSize(64);
    assertThat(gv.get("alg").asText()).isEqualTo("ES256");
  }

  @Test
  void independentEcdsaVerificationOfTheGoldenTokenSucceeds() throws Exception {
    JsonNode gv = loadGoldenVector();
    String token = gv.get("token").asText();
    String[] parts = token.split("\\.");
    byte[] rs = B64URL.decode(parts[2]);
    assertThat(rs).hasSize(64);

    PublicKey pub =
        KeyFactory.getInstance("EC")
            .generatePublic(
                new X509EncodedKeySpec(
                    Base64.getDecoder().decode(gv.get("public_key_spki_b64").asText())));

    // Independent P1363 -> DER using BigInteger (which supplies its own sign byte) — deliberately NOT
    // EcdsaP1363, so a bug there cannot hide behind identical code on both sides.
    BigInteger r = new BigInteger(1, Arrays.copyOfRange(rs, 0, 32));
    BigInteger s = new BigInteger(1, Arrays.copyOfRange(rs, 32, 64));
    byte[] der = independentDer(r, s);

    byte[] signingInput = (parts[0] + "." + parts[1]).getBytes(StandardCharsets.US_ASCII);
    Signature v = Signature.getInstance("SHA256withECDSA");
    v.initVerify(pub);
    v.update(signingInput);
    assertThat(v.verify(der)).as("independent ES256 verify of the golden token").isTrue();

    // And it really is verifying R||S, not DER: feeding the raw 64 bytes to the DER-expecting JDK
    // verifier must NOT verify (guards against "we accidentally treated DER as R||S everywhere").
    Signature vRaw = Signature.getInstance("SHA256withECDSA");
    vRaw.initVerify(pub);
    vRaw.update(signingInput);
    boolean rawAccepted;
    try {
      rawAccepted = vRaw.verify(rs);
    } catch (Exception malformedDer) {
      rawAccepted = false; // JDK rejects the 64 raw bytes as malformed DER — expected
    }
    assertThat(rawAccepted).as("raw R||S must NOT verify as DER").isFalse();
  }

  @Test
  void productionVerifierAcceptsTheGoldenTokenAndDecodesTheExpectedPayload() throws Exception {
    JsonNode gv = loadGoldenVector();
    String token = gv.get("token").asText();

    AppProperties props = new AppProperties();
    AppProperties.SigningKey sk = new AppProperties.SigningKey();
    sk.setKid(gv.get("kid").asText());
    sk.setAlg("ES256");
    sk.setPublicKey(gv.get("public_key_spki_b64").asText());
    sk.setActive(false); // verify-only is enough
    List<AppProperties.SigningKey> keys = new ArrayList<>();
    keys.add(sk);
    props.getLicensing().setKeys(keys);

    LicenseVerifier verifier = new LicenseVerifier(new TrustedKeySet(props), props);
    LicensePayload p = verifier.verify(token);

    JsonNode expected = gv.get("expected_payload");
    assertThat(p.licenseId()).isEqualTo(expected.get("license_id").asText());
    assertThat(p.sub()).isEqualTo(expected.get("sub").asText());
    assertThat(p.skillId()).isEqualTo(expected.get("skill_id").asText());
    assertThat(p.deviceId()).isEqualTo(expected.get("device_id").asText());
    assertThat(p.deviceBinding()).isEqualTo(expected.get("device_binding").asText());
    assertThat(p.entitlement()).isEqualTo("perpetual");
    assertThat(p.exp()).isNull();
    assertThat(p.iss()).isEqualTo("hydropark-licensing");
    assertThat(p.maxDevices()).isEqualTo(expected.get("max_devices").asInt());
  }

  @Test
  void aTamperedGoldenTokenFailsProductionVerification() throws Exception {
    JsonNode gv = loadGoldenVector();
    String token = gv.get("token").asText();
    String[] parts = token.split("\\.");
    char c = parts[1].charAt(2);
    char flipped = (c == 'A') ? 'B' : 'A';
    String tampered = parts[0] + "." + (parts[1].substring(0, 2) + flipped + parts[1].substring(3)) + "." + parts[2];

    AppProperties props = new AppProperties();
    AppProperties.SigningKey sk = new AppProperties.SigningKey();
    sk.setKid(gv.get("kid").asText());
    sk.setAlg("ES256");
    sk.setPublicKey(gv.get("public_key_spki_b64").asText());
    List<AppProperties.SigningKey> keys = new ArrayList<>();
    keys.add(sk);
    props.getLicensing().setKeys(keys);

    LicenseVerifier verifier = new LicenseVerifier(new TrustedKeySet(props), props);
    assertThatThrownBy(() -> verifier.verify(tampered))
        .isInstanceOf(LicenseVerificationException.class);
  }

  /** Minimal DER {@code SEQUENCE{INTEGER r, INTEGER s}} using BigInteger's own two's-complement bytes. */
  private static byte[] independentDer(BigInteger r, BigInteger s) {
    byte[] ri = derInteger(r);
    byte[] si = derInteger(s);
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    out.write(0x30);
    out.write(ri.length + si.length); // P-256: always < 128
    out.write(ri, 0, ri.length);
    out.write(si, 0, si.length);
    return out.toByteArray();
  }

  private static byte[] derInteger(BigInteger v) {
    byte[] b = v.toByteArray(); // minimal signed big-endian: supplies its own 0x00 sign byte if needed
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    out.write(0x02);
    out.write(b.length); // P-256 integer: always < 128
    out.write(b, 0, b.length);
    return out.toByteArray();
  }
}
