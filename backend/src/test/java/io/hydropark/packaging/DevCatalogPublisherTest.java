package io.hydropark.packaging;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.hydropark.download.BlobStoreProperties;
import io.hydropark.download.LocalFsBlobStore;
import io.hydropark.signing.JdkEd25519Signer;
import io.hydropark.signing.Signer;
import io.hydropark.signing.SigningKeyRef;
import java.io.ByteArrayInputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PrivateKey;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * P1-23.3 round-trip: {@link DevCatalogPublisher} publishes one certified manifest into a
 * temp-dir-rooted {@link LocalFsBlobStore}, and the resulting {@code .hpskill} bytes are exactly
 * what {@link PackageSignatureVerifier} accepts and what {@code hpskill.rs}'s {@code
 * HpSkill::open_bytes} expects: a zip whose only required entry is a top-level {@code
 * manifest.json} carrying a detached {@code ed25519:<base64>} signature over the RFC 8785 JCS
 * canonicalization of the manifest-minus-signature-fields.
 *
 * <p>Pure JUnit — no Spring context, no Docker. Builds its own {@link PackageSigner} /
 * {@link PackageSignatureVerifier} from a freshly generated Ed25519 test keypair, exactly as
 * {@code PackageSigningTest} does, so this test needs no real {@code HP_PACKAGE_SIGNING_*} secret.
 */
class DevCatalogPublisherTest {

  private static final ObjectMapper MAPPER = new ObjectMapper();

  private record Key(String kid, KeyPair kp) {}

  private static Key freshKey(String kid) throws Exception {
    return new Key(kid, KeyPairGenerator.getInstance("Ed25519").generateKeyPair());
  }

  private static PackageSigner signerFor(Key k) {
    Signer s =
        new JdkEd25519Signer(
            new SigningKeyRef(k.kid(), k.kp().getPublic()),
            Map.of(k.kid(), (PrivateKey) k.kp().getPrivate()));
    return new PackageSigner(s);
  }

  private static PackageSignatureVerifier verifierTrusting(Key k) {
    List<PackageSigningProperties.Key> cfg = new ArrayList<>();
    PackageSigningProperties.Key key = new PackageSigningProperties.Key();
    key.setKid(k.kid());
    key.setAlg("Ed25519");
    key.setPublicKey(Base64.getEncoder().encodeToString(k.kp().getPublic().getEncoded()));
    key.setActive(true);
    cfg.add(key);
    return new PackageSignatureVerifier(new PackageTrustedKeySet(cfg, 5));
  }

  @Test
  void publishOneManifestProducesAnArchiveThePackageVerifierAccepts(@TempDir Path tempDir)
      throws Exception {
    Key k = freshKey("hp-pkg-test");
    PackageSigner signer = signerFor(k);
    PackageSignatureVerifier verifier = verifierTrusting(k);

    BlobStoreProperties props = new BlobStoreProperties();
    props.setLocalRoot(tempDir.toString());
    LocalFsBlobStore blobStore = new LocalFsBlobStore(props);

    DevCatalogPublisher publisher = new DevCatalogPublisher(signer, blobStore);
    var catalogDir = DevCatalogPublisher.catalogDir();

    publisher.publishOne(catalogDir, "kitchen-timer");

    // The objectKey convention DownloadService resolves GET /v1/download/skills/{id}/{version}
    // to (mirrors CatalogSeeder's skill_versions.package_uri = "skills/{id}/{version}/package.hpskill").
    String objectKey = DevCatalogPublisher.objectKey("kitchen-timer", "1.0.0");
    assertThat(objectKey).isEqualTo("skills/kitchen-timer/1.0.0/package.hpskill");

    Path published = tempDir.resolve(objectKey);
    assertThat(published).exists();
    byte[] archive = Files.readAllBytes(published);

    // The archive is a zip containing (only) manifest.json — the hpskill.rs layout.
    byte[] manifestBytes = null;
    List<String> entryNames = new ArrayList<>();
    try (ZipInputStream zis = new ZipInputStream(new ByteArrayInputStream(archive))) {
      ZipEntry entry;
      while ((entry = zis.getNextEntry()) != null) {
        entryNames.add(entry.getName());
        if ("manifest.json".equals(entry.getName())) {
          manifestBytes = zis.readAllBytes();
        }
      }
    }
    assertThat(entryNames).contains("manifest.json");
    assertThat(manifestBytes).isNotNull();

    JsonNode signedManifest = MAPPER.readTree(manifestBytes);
    assertThat(signedManifest.path("id").asText()).isEqualTo("kitchen-timer");
    assertThat(signedManifest.path("signature").asText()).startsWith("ed25519:");
    assertThat(signedManifest.path("signing_key_id").asText()).isEqualTo("hp-pkg-test");

    // THE gate: PackageSignatureVerifier (the same class the registry submission path uses)
    // accepts the published archive's manifest.
    assertThat(verifier.verify(signedManifest)).isEqualTo("hp-pkg-test");
  }

  @Test
  void objectKeyMatchesTheDownloadServiceConvention() {
    assertThat(DevCatalogPublisher.objectKey("cooking-assistant", "1.0.0"))
        .isEqualTo("skills/cooking-assistant/1.0.0/package.hpskill");
  }

  @Test
  void runPublishesAllTenCertifiedSkills(@TempDir Path tempDir) throws Exception {
    Key k = freshKey("hp-pkg-test");
    BlobStoreProperties props = new BlobStoreProperties();
    props.setLocalRoot(tempDir.toString());
    LocalFsBlobStore blobStore = new LocalFsBlobStore(props);
    DevCatalogPublisher publisher = new DevCatalogPublisher(signerFor(k), blobStore);

    publisher.run(null);

    for (String id : DevCatalogPublisher.CATALOG_SKILL_IDS) {
      Path p = tempDir.resolve("skills/" + id + "/1.0.0/package.hpskill");
      assertThat(p).as("published archive for %s", id).exists();
    }
    assertThat(DevCatalogPublisher.CATALOG_SKILL_IDS).hasSize(10);
  }
}
