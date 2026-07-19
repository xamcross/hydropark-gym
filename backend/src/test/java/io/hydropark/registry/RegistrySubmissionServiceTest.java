package io.hydropark.registry;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.hydropark.certification.CertificationReport;
import io.hydropark.certification.CertificationService;
import io.hydropark.packaging.PackageSignature;
import io.hydropark.packaging.PackageSignatureVerifier;
import io.hydropark.packaging.PackageSigner;
import io.hydropark.packaging.PackageSigningProperties;
import io.hydropark.packaging.PackageTrustedKeySet;
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
 * P1-20: the submission service certifies a signed, valid manifest and rejects a tampered one — with
 * an in-process signer/verifier over a generated Ed25519 test keypair, the real {@link
 * CertificationService}, and no Spring context or Docker.
 */
class RegistrySubmissionServiceTest {

  private static final ObjectMapper MAPPER = new ObjectMapper();
  private static final String KID = "hp-pkg-test";

  private final KeyPair kp = ed25519();
  private final RegistrySubmissionService service =
      new RegistrySubmissionService(verifierTrusting(kp), new CertificationService());

  private static KeyPair ed25519() {
    try {
      return KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
    } catch (Exception e) {
      throw new RuntimeException("failed to generate Ed25519 test key", e);
    }
  }

  private static ObjectNode manifest() throws Exception {
    try (InputStream in =
        RegistrySubmissionServiceTest.class.getResourceAsStream(
            "/certification/examples/kitchen-timer.manifest.json")) {
      assertThat(in).isNotNull();
      return (ObjectNode) MAPPER.readTree(in);
    }
  }

  private PackageSigner signer() {
    Signer s =
        new JdkEd25519Signer(
            new SigningKeyRef(KID, kp.getPublic()), Map.of(KID, (PrivateKey) kp.getPrivate()));
    return new PackageSigner(s);
  }

  private static PackageSignatureVerifier verifierTrusting(KeyPair kp) {
    PackageSigningProperties.Key key = new PackageSigningProperties.Key();
    key.setKid(KID);
    key.setAlg("Ed25519");
    key.setPublicKey(Base64.getEncoder().encodeToString(kp.getPublic().getEncoded()));
    key.setActive(true);
    List<PackageSigningProperties.Key> cfg = new ArrayList<>();
    cfg.add(key);
    return new PackageSignatureVerifier(new PackageTrustedKeySet(cfg, 5));
  }

  private ObjectNode signedManifest() throws Exception {
    ObjectNode m = manifest();
    PackageSignature sig = signer().sign(m);
    m.put("signature", sig.signature());
    m.put("signing_key_id", sig.signingKeyId());
    return m;
  }

  @Test
  void certifiesASignedValidManifest() throws Exception {
    CertificationReport r = service.certifySubmission(signedManifest());
    assertThat(r.passed()).as("errors: %s", r.errors()).isTrue();
  }

  @Test
  void rejectsATamperedManifestWithASignatureError() throws Exception {
    ObjectNode m = signedManifest();
    m.put("summary", "tampered after signing"); // mutate a signed field

    CertificationReport r = service.certifySubmission(m);
    assertThat(r.passed()).isFalse();
    assertThat(r.hasCode("signature_mismatch")).isTrue();
  }

  @Test
  void rejectsAnUnsignedManifest() throws Exception {
    CertificationReport r = service.certifySubmission(manifest());
    assertThat(r.passed()).isFalse();
    assertThat(r.hasCode("signature_missing")).isTrue();
  }
}
