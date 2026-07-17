package io.hydropark.packaging;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.hydropark.port.Ports;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/**
 * Dev-only tool (P1-23.3, follow-on to the P1-23.2 final-bundle packager) that builds and
 * publishes a real, signed {@code .hpskill} archive for every certified launch-catalog manifest
 * under {@code contracts/catalog/} (P1-22), so the client's download → install path has something
 * real to fetch instead of {@link io.hydropark.seed.CatalogSeeder}'s placeholder {@code
 * skill_versions} rows.
 *
 * <p><b>Format.</b> Reuses the existing package-signing machinery verbatim — {@link PackageSigner}
 * signs the manifest exactly as {@code PackageSignerConfig} wires it in production (Ed25519 over
 * the RFC 8785 JCS canonicalization of the manifest with {@code signature}/{@code signing_key_id}
 * removed, {@link ManifestCanonicalizer}) — and writes the signed manifest back as the wire fields
 * the schema declares. The archive is a zip whose only member is the top-level {@code
 * manifest.json}; that is the minimal shape {@code hpskill.rs}'s {@code HpSkill::open_bytes}
 * accepts (its 12 security tests build the same single-entry zip for every accept case). No
 * {@code assets/*.svg} or {@code strings/<locale>.json} entries are emitted: the certified
 * manifests declare {@code resources.icon}/{@code resources.assets}/{@code resources.strings} but
 * no actual SVG/string files exist anywhere in the repo to package, and neither the backend
 * certification pipeline nor the Rust manifest validator requires a declared resource to be
 * physically present in the archive — only that any entry which IS present passes sanitization.
 *
 * <p><b>Placement.</b> {@link io.hydropark.packaging} was chosen over {@link io.hydropark.seed}
 * because this class's entire job — build + sign a {@code .hpskill} — is packaging-domain logic
 * that reuses {@link PackageSigner}/{@link ManifestCanonicalizer} directly; {@code CatalogSeeder}
 * writes Mongo catalog rows and has no signing dependency at all. Keeping this here also avoids
 * giving the seed package a dependency on the packaging package's signing beans.
 *
 * <p><b>Object key.</b> Publishes each archive under {@code skills/{skillId}/{version}/package.hpskill}
 * — byte-for-byte the same convention {@link io.hydropark.seed.CatalogSeeder#seedSkillVersions()}
 * writes into {@code skill_versions.package_uri}, which {@link io.hydropark.download.DownloadService}
 * reads via {@code SkillVersion.getPackageUri()} to mint the signed download URL for {@code GET
 * /v1/download/skills/{skillId}/{version}}.
 *
 * <p>Gated on {@code hydropark.seed.publish-packages} (default false, unset in every {@code
 * application.yml} profile — pass {@code --hydropark.seed.publish-packages=true} as a CLI arg to
 * run it). Requires a {@link PackageSigner} bean, i.e. {@code hydropark.package-signing.enabled=true}
 * with a private key configured (the same {@code HP_PACKAGE_SIGNING_*} secrets {@link
 * PackageSignerConfig} already requires) — this dev tool never holds or generates its own key. The
 * {@link PackageSigner} dependency is an {@link ObjectProvider} rather than a direct constructor
 * argument specifically so a zone that enables {@code hydropark.seed.publish-packages} without also
 * enabling package-signing fails with an actionable {@link IllegalStateException} at {@link #run}
 * time (see {@link #requireSigner()}) instead of a raw Spring {@code NoSuchBeanDefinitionException}
 * at context-refresh time.
 *
 * <p>Depends on {@link Ports.BlobStorePort} rather than the concrete {@code
 * io.hydropark.download.BlobStore}/{@code LocalFsBlobStore} — the cross-package contract {@code
 * io.hydropark.port.Ports} exists precisely so a publishing tool in another package never imports
 * the {@code download} domain directly (see the port's own doc comment).
 */
@Component
@Order(3)
@ConditionalOnProperty(name = "hydropark.seed.publish-packages", havingValue = "true")
public class DevCatalogPublisher implements ApplicationRunner {

  private static final Logger log = LoggerFactory.getLogger(DevCatalogPublisher.class);

  /** The single required archive member — the layout {@code hpskill.rs}'s `MANIFEST_ENTRY` pins. */
  static final String MANIFEST_ENTRY = "manifest.json";

  /**
   * The certified launch catalog (P1-22): 2 free + 8 paid, exactly the ids {@code
   * CatalogCertificationTest}/{@code CatalogSeederManifestConsistencyTest} pin against {@code
   * contracts/catalog/*.manifest.json}.
   */
  static final List<String> CATALOG_SKILL_IDS =
      List.of(
          "kitchen-timer",
          "packing-list",
          "cooking-assistant",
          "travel-planner",
          "nutrition-coach",
          "home-diy",
          "garden-plants",
          "car-care",
          "budget-bills",
          "study-flashcards");

  /**
   * The actionable failure message when {@code hydropark.seed.publish-packages=true} but no {@link
   * PackageSigner} bean was ever wired (i.e. {@code hydropark.package-signing.enabled} is not
   * {@code true} on this zone). Exposed as a constant so the test asserting it can pin the exact
   * string without duplicating it.
   */
  static final String SIGNER_MISSING_MESSAGE =
      "hydropark.seed.publish-packages=true requires hydropark.package-signing.enabled=true"
          + " (HP_PACKAGE_SIGNING_ENABLED)";

  private static final ObjectMapper MAPPER = new ObjectMapper();

  private final ObjectProvider<PackageSigner> signerProvider;
  private final Ports.BlobStorePort blobStore;

  public DevCatalogPublisher(ObjectProvider<PackageSigner> signerProvider, Ports.BlobStorePort blobStore) {
    this.signerProvider = signerProvider;
    this.blobStore = blobStore;
  }

  @Override
  public void run(ApplicationArguments args) {
    PackageSigner signer = requireSigner();
    File dir = catalogDir();
    int count = 0;
    for (String skillId : CATALOG_SKILL_IDS) {
      publishOne(dir, skillId, signer);
      count++;
    }
    log.info("dev catalog publisher: published {} signed .hpskill package(s) to the blob root", count);
  }

  /**
   * Resolves the package-signing bean, failing loudly and actionably (naming both flags) rather
   * than letting Spring's context refresh fail with an opaque {@code NoSuchBeanDefinitionException}
   * — or, worse, letting this runner silently no-op if a future refactor ever made the dependency
   * optional-and-ignored.
   */
  PackageSigner requireSigner() {
    PackageSigner signer = signerProvider.getIfAvailable();
    if (signer == null) {
      throw new IllegalStateException(SIGNER_MISSING_MESSAGE);
    }
    return signer;
  }

  /** Publishes one certified manifest's signed {@code .hpskill} archive. Package-private for tests. */
  void publishOne(File catalogDir, String skillId, PackageSigner signer) {
    JsonNode manifest = readManifest(catalogDir, skillId);
    String version = manifest.path("version").asText("");
    if (version.isBlank()) {
      throw new IllegalStateException("manifest '" + skillId + "' has no 'version' field");
    }
    byte[] signedManifestBytes = signManifest(manifest, signer);
    byte[] archive = buildArchive(signedManifestBytes);
    String objectKey = objectKey(skillId, version);
    blobStore.store(objectKey, archive);
    log.info("published {} {} -> {} ({} bytes)", skillId, version, objectKey, archive.length);
  }

  /**
   * Resolves {@code contracts/catalog/}. Mirrors {@code CatalogCertificationTest#catalogDir()} /
   * {@code CatalogSeederManifestConsistencyTest#catalogDir()} exactly: surefire (and the app's own
   * working directory when launched from {@code backend/}) resolves {@code ../contracts/catalog} to
   * the repo-root catalog, with a repo-root-relative fallback for a differently-rooted launcher.
   */
  static File catalogDir() {
    File fromModule = new File("../contracts/catalog");
    if (fromModule.isDirectory()) {
      return fromModule;
    }
    File fromRoot = new File("contracts/catalog");
    if (fromRoot.isDirectory()) {
      return fromRoot;
    }
    throw new IllegalStateException(
        "contracts/catalog not found. Tried "
            + fromModule.getAbsolutePath()
            + " and "
            + fromRoot.getAbsolutePath());
  }

  private static JsonNode readManifest(File catalogDir, String skillId) {
    File f = new File(catalogDir, skillId + ".manifest.json");
    if (!f.isFile()) {
      throw new IllegalStateException(
          "no certified manifest for '" + skillId + "' at " + f.getAbsolutePath());
    }
    try {
      return MAPPER.readTree(f);
    } catch (IOException e) {
      throw new UncheckedIOException("failed to read manifest " + f, e);
    }
  }

  /**
   * Signs a copy of {@code manifest} with the package-signing key and writes the resulting {@code
   * signature}/{@code signing_key_id} fields back into it, via {@link PackageSigner} directly —
   * the same signer bean {@link PackageSignerConfig} wires for the registry/signing zone. (No
   * production caller signs a package today — {@code RegistrySubmissionController} only certifies,
   * P1-19/P1-20 — so this dev tool is the first real exerciser of {@link PackageSigner} end to end.)
   */
  private byte[] signManifest(JsonNode manifest, PackageSigner signer) {
    ObjectNode copy = (ObjectNode) manifest.deepCopy();
    PackageSignature sig = signer.sign(copy);
    copy.put(ManifestCanonicalizer.SIGNATURE_FIELD, sig.signature());
    copy.put(ManifestCanonicalizer.SIGNING_KEY_ID_FIELD, sig.signingKeyId());
    try {
      return MAPPER.writeValueAsBytes(copy);
    } catch (IOException e) {
      throw new UncheckedIOException("failed to serialize signed manifest", e);
    }
  }

  /**
   * Builds a {@code .hpskill} zip containing only the signed {@code manifest.json} — the minimal
   * layout {@code hpskill.rs}'s {@code HpSkill::open_bytes} accepts. Deflate compression (Java's
   * {@link ZipOutputStream} default) matches the {@code deflate} feature the Rust {@code zip} crate
   * is built with (see {@code client/src-tauri/Cargo.toml}), and is what the Rust suite's own {@code
   * build_zip} test helper uses.
   */
  static byte[] buildArchive(byte[] signedManifestBytes) {
    ByteArrayOutputStream buf = new ByteArrayOutputStream();
    try (ZipOutputStream zip = new ZipOutputStream(buf, StandardCharsets.UTF_8)) {
      zip.putNextEntry(new ZipEntry(MANIFEST_ENTRY));
      zip.write(signedManifestBytes);
      zip.closeEntry();
    } catch (IOException e) {
      throw new UncheckedIOException("failed to build .hpskill archive", e);
    }
    return buf.toByteArray();
  }

  /**
   * The object key {@link io.hydropark.download.DownloadService} resolves {@code GET
   * /v1/download/skills/{skillId}/{version}} to (byte-for-byte {@code CatalogSeeder}'s {@code
   * skill_versions.package_uri} convention).
   */
  static String objectKey(String skillId, String version) {
    return "skills/" + skillId + "/" + version + "/package.hpskill";
  }
}
