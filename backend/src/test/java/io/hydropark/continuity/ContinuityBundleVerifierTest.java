package io.hydropark.continuity;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.hydropark.config.AppProperties;
import io.hydropark.licensing.LicenseSigner;
import io.hydropark.licensing.LicenseVerifier;
import io.hydropark.licensing.SignerConfig;
import io.hydropark.licensing.TrustedKeySet;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.spec.ECGenParameterSpec;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * The P1-23.2 verify path accepts a well-formed bundle and rejects a tampered one - using <b>real</b>
 * ES256 license crypto (a key generated in-test), so a flipped signature byte is caught by the actual
 * verifier, not a stub. Crucially the verifier holds a {@link LicenseVerifier} and <b>no signer</b>:
 * verifying can never mint. Pure JCA; no Docker.
 */
class ContinuityBundleVerifierTest {

  private LicenseSigner signer;
  private ContinuityBundleVerifier bundleVerifier;

  private static final SkillPackageRef REF_A =
      new SkillPackageRef("skillA", "1.0.0", "blob://a", "sha-a", "hp-pkg-2026a");
  private static final SkillPackageRef REF_B =
      new SkillPackageRef("skillB", "1.0.0", "blob://b", "sha-b", "hp-pkg-2026a");

  @BeforeEach
  void setUp() throws Exception {
    KeyPairGenerator g = KeyPairGenerator.getInstance("EC");
    g.initialize(new ECGenParameterSpec("secp256r1"));
    KeyPair kp = g.generateKeyPair();

    AppProperties.SigningKey sk = new AppProperties.SigningKey();
    sk.setKid("hp-lic-test");
    sk.setAlg("ES256");
    sk.setActive(true);
    sk.setPrivateKey(Base64.getEncoder().encodeToString(kp.getPrivate().getEncoded()));
    sk.setPublicKey(Base64.getEncoder().encodeToString(kp.getPublic().getEncoded()));

    AppProperties props = new AppProperties();
    props.getLicensing().setKeys(new ArrayList<>(List.of(sk)));

    TrustedKeySet keys = new TrustedKeySet(props);
    signer = new LicenseSigner(SignerConfig.signerFrom(keys), props);
    bundleVerifier = new ContinuityBundleVerifier(new LicenseVerifier(keys, props));
  }

  @Test
  void acceptsAWellFormedBundleAndReturnsTheInstallableSet() {
    String tokenA = mint("licA", "user1", "skillA");
    String tokenB = mint("licB", "user1", "skillB");
    ContinuityBundle bundle = bundle(manifest("user1", 2, 2), List.of(REF_A, REF_B), List.of(tokenA, tokenB));

    ContinuityBundleVerification v = bundleVerifier.verify(bundle);

    assertThat(v.userId()).isEqualTo("user1");
    assertThat(v.installablePackages()).hasSize(2);
    assertThat(v.installableLicenses())
        .extracting(io.hydropark.licensing.LicensePayload::licenseId)
        .containsExactlyInAnyOrder("licA", "licB");
  }

  @Test
  void rejectsABundleWithATamperedLicenseSignature() {
    String tokenA = mint("licA", "user1", "skillA");
    String tokenB = mint("licB", "user1", "skillB");
    String tamperedA = tamperSignature(tokenA);
    ContinuityBundle tampered =
        bundle(manifest("user1", 2, 2), List.of(REF_A, REF_B), List.of(tamperedA, tokenB));

    assertThatThrownBy(() -> bundleVerifier.verify(tampered))
        .isInstanceOf(ContinuityBundleException.class)
        .extracting(e -> ((ContinuityBundleException) e).code())
        .isEqualTo("license_signature_invalid");
  }

  @Test
  void rejectsABundleWhoseManifestCountDisagreesWithTheBody() {
    String tokenA = mint("licA", "user1", "skillA");
    String tokenB = mint("licB", "user1", "skillB");
    // Manifest claims 3 skills but the body has 2 -> structural tamper.
    ContinuityBundle bundle = bundle(manifest("user1", 3, 2), List.of(REF_A, REF_B), List.of(tokenA, tokenB));

    assertThatThrownBy(() -> bundleVerifier.verify(bundle))
        .isInstanceOf(ContinuityBundleException.class)
        .extracting(e -> ((ContinuityBundleException) e).code())
        .isEqualTo("manifest_count_mismatch");
  }

  @Test
  void rejectsALicenseBoundToADifferentUser() {
    // A token for user2 slipped into user1's bundle (its id is even listed) must still be rejected.
    String foreign = mint("licX", "user2", "skillA");
    ContinuityBundleManifest m =
        new ContinuityBundleManifest(
            "cb", "user1", Instant.now(), 1, 1, List.of("skillA"), List.of("licX"));
    ContinuityBundle bundle = new ContinuityBundle(m, List.of(REF_A), List.of(foreign));

    assertThatThrownBy(() -> bundleVerifier.verify(bundle))
        .isInstanceOf(ContinuityBundleException.class)
        .extracting(e -> ((ContinuityBundleException) e).code())
        .isEqualTo("license_wrong_owner");
  }

  @Test
  void acceptsAnEmptyButConsistentBundle() {
    ContinuityBundleManifest m =
        new ContinuityBundleManifest("cb-empty", "user1", Instant.now(), 0, 0, List.of(), List.of());
    ContinuityBundle empty = new ContinuityBundle(m, List.of(), List.of());
    assertThatCode(() -> bundleVerifier.verify(empty)).doesNotThrowAnyException();
  }

  private String mint(String licenseId, String user, String skill) {
    return signer.sign(licenseId, user, skill, "dev1", "fp-dev1").token();
  }

  private static ContinuityBundleManifest manifest(String user, int skillCount, int licenseCount) {
    return new ContinuityBundleManifest(
        "cb-1",
        user,
        Instant.now(),
        skillCount,
        licenseCount,
        List.of("skillA", "skillB"),
        List.of("licA", "licB"));
  }

  private static ContinuityBundle bundle(
      ContinuityBundleManifest manifest, List<SkillPackageRef> packages, List<String> tokens) {
    return new ContinuityBundle(manifest, packages, tokens);
  }

  /** Flip the first character of the signature segment - guaranteed to alter a signature byte. */
  private static String tamperSignature(String token) {
    int lastDot = token.lastIndexOf('.');
    char[] c = token.toCharArray();
    int i = lastDot + 1;
    c[i] = (c[i] == 'A') ? 'B' : 'A';
    return new String(c);
  }
}
