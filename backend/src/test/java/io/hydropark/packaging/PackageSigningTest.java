package io.hydropark.packaging;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.hydropark.signing.JdkEd25519Signer;
import io.hydropark.signing.Signer;
import io.hydropark.signing.SigningKeyRef;
import java.io.InputStream;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PrivateKey;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Package sign → verify round-trip, tamper rejection, and unknown-kid rejection — the package-signing
 * counterpart to {@code licensing.LicenseCryptoTest}. Pure JUnit; a generated Ed25519 test keypair,
 * no Spring context, no Mongo. Proves the package key is exercised end-to-end entirely independently
 * of the license key.
 */
class PackageSigningTest {

  private static final ObjectMapper MAPPER = new ObjectMapper();

  private record Key(String kid, KeyPair kp) {}

  private static Key freshKey(String kid) throws Exception {
    return new Key(kid, KeyPairGenerator.getInstance("Ed25519").generateKeyPair());
  }

  private static ObjectNode manifest() throws Exception {
    try (InputStream in =
        PackageSigningTest.class.getResourceAsStream(
            "/certification/examples/kitchen-timer.manifest.json")) {
      assertThat(in).isNotNull();
      return (ObjectNode) MAPPER.readTree(in);
    }
  }

  private static PackageSigner signerFor(Key k) {
    Signer s =
        new JdkEd25519Signer(
            new SigningKeyRef(k.kid(), k.kp().getPublic()),
            Map.of(k.kid(), (PrivateKey) k.kp().getPrivate()));
    return new PackageSigner(s);
  }

  /** A verifier trusting only the PUBLIC halves of the given keys (no private material). */
  private static PackageSignatureVerifier verifierTrusting(Key... ks) {
    List<PackageSigningProperties.Key> cfg = new ArrayList<>();
    for (Key k : ks) {
      PackageSigningProperties.Key key = new PackageSigningProperties.Key();
      key.setKid(k.kid());
      key.setAlg("Ed25519");
      key.setPublicKey(Base64.getEncoder().encodeToString(k.kp().getPublic().getEncoded()));
      key.setActive(true);
      cfg.add(key);
    }
    return new PackageSignatureVerifier(new PackageTrustedKeySet(cfg, 5));
  }

  private static ObjectNode signed(Key k, ObjectNode m) {
    PackageSignature sig = signerFor(k).sign(m);
    m.put("signature", sig.signature());
    m.put("signing_key_id", sig.signingKeyId());
    return m;
  }

  @Test
  void signThenVerifyRoundTrips() throws Exception {
    Key k = freshKey("hp-pkg-test");
    ObjectNode m = signed(k, manifest());

    assertThat(m.get("signature").asText()).startsWith("ed25519:");
    assertThat(verifierTrusting(k).verify(m)).isEqualTo("hp-pkg-test");
  }

  @Test
  void signatureExcludesTheSignatureFieldsThemselves() throws Exception {
    // Signing is stable whether or not stale signature/kid fields are already present: they are
    // stripped before canonicalization, and Ed25519 is deterministic.
    Key k = freshKey("hp-pkg-test");
    PackageSignature first = signerFor(k).sign(manifest());

    ObjectNode withStale = manifest();
    withStale.put("signature", "ed25519:stale-value-that-must-be-ignored");
    withStale.put("signing_key_id", "some-other-kid");
    PackageSignature second = signerFor(k).sign(withStale);

    assertThat(second.signature()).isEqualTo(first.signature());
  }

  @Test
  void tamperedManifestFailsVerification() throws Exception {
    Key k = freshKey("hp-pkg-test");
    ObjectNode m = signed(k, manifest());
    m.put("name", "Tampered display name"); // mutate a signed field after signing

    assertThatThrownBy(() -> verifierTrusting(k).verify(m))
        .isInstanceOf(PackageSignatureException.class)
        .satisfies(
            e -> assertThat(((PackageSignatureException) e).code()).isEqualTo("signature_mismatch"));
  }

  @Test
  void unknownKidFailsVerification() throws Exception {
    Key signing = freshKey("hp-pkg-signing");
    Key trusted = freshKey("hp-pkg-other");
    ObjectNode m = signed(signing, manifest());

    assertThatThrownBy(() -> verifierTrusting(trusted).verify(m))
        .isInstanceOf(PackageSignatureException.class)
        .satisfies(
            e -> assertThat(((PackageSignatureException) e).code()).isEqualTo("unknown_signing_key"));
  }

  @Test
  void missingSignatureFailsVerification() throws Exception {
    Key k = freshKey("hp-pkg-test");
    ObjectNode unsigned = manifest(); // no signature fields at all

    assertThatThrownBy(() -> verifierTrusting(k).verify(unsigned))
        .isInstanceOf(PackageSignatureException.class)
        .satisfies(
            e -> assertThat(((PackageSignatureException) e).code()).isEqualTo("signature_missing"));
  }
}
