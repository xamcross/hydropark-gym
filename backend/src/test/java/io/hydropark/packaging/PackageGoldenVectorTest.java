package io.hydropark.packaging;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.fail;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.util.Base64;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * CROSS-LANGUAGE GOLDEN VECTOR for skill-<b>package</b> signing. The signature is produced here (Java,
 * {@link PackageSigner}) and verified in a <b>separate Rust client</b>; RFC 8785 (JCS) canonicalization
 * is what makes those two agree byte-for-byte (see {@link ManifestCanonicalizer}). This test pins a
 * fixed, representative manifest — strings with unicode + a newline, integers, nested objects, an array,
 * and a {@code tools[]} entry with a {@code config} object — into a committed fixture that both sides
 * check against:
 *
 * <ul>
 *   <li>{@code manifest} — the signed manifest object (signature + signing_key_id populated).
 *   <li>{@code package_public_key_b64} — the Ed25519 public key, X.509 SPKI, base64.
 *   <li>{@code kid} — the signing key id.
 *   <li>{@code jcs_canonical} — the JCS canonical string of the manifest-minus-signature, for the Rust
 *       side to diff byte-for-byte against its own canonicalizer output.
 * </ul>
 *
 * <p><b>NORMAL run</b> (no system property): loads the committed fixture, asserts our verifier accepts
 * it, that a byte-tampered copy is rejected, and that {@code jcs_canonical} still matches what our
 * canonicalizer computes. If the fixture is absent the build fails with the exact regenerate command.
 *
 * <p><b>GENERATOR run</b> ({@code -Dhp.generate.golden=true}): mints a fresh Ed25519 keypair, signs the
 * fixed manifest through the real {@link PackageSigner} wired from a package trusted-set holding that
 * key, and (re)writes the fixture. Regenerate whenever the canonicalizer or the fixed manifest changes;
 * the Rust suite then re-syncs against the new {@code jcs_canonical}. Pure JUnit — no Spring, no Mongo.
 */
class PackageGoldenVectorTest {

  private static final ObjectMapper MAPPER = new ObjectMapper();

  /** Surefire runs with cwd = {@code backend/}, so this resolves to the repo-root contracts dir. */
  private static final Path FIXTURE =
      Paths.get("..", "contracts", "testdata", "package-signing-golden.json");

  private static final String GENERATE_CMD =
      "mvn -Dhp.generate.golden=true -Dtest=PackageGoldenVectorTest test";

  /**
   * The fixed representative manifest. Built in code (not read from a resource) so the vector is
   * self-contained and stable. Deliberately exercises everything that made the old Jackson form
   * cross-language-unstable: a unicode-bearing string, an embedded newline, integers, nested objects,
   * an array, and a {@code tools[]} entry with a {@code config} object.
   */
  private static ObjectNode fixedManifest() {
    ObjectNode m = MAPPER.createObjectNode();
    m.put("manifest_version", "1.0");
    m.put("id", "golden-vector-skill");
    m.put("name", "Golden Vector — café façade"); // unicode: é, ç, em dash

    ObjectNode persona = MAPPER.createObjectNode();
    persona.put("role", "primary_eligible");
    // Newline + non-breaking space + arrow + degree sign: the exact string-escaping variance JCS pins.
    persona.put(
        "system_prompt",
        "Line one — be brief.\nLine two: convert café measures, e.g. 200 g → 7 oz at 30°C.");
    m.set("persona", persona);

    ObjectNode requirements = MAPPER.createObjectNode();
    requirements.put("min_params_b", 3); // integer
    requirements.put("min_ram_gb", 8); // integer
    m.set("requirements", requirements);

    ArrayNode capabilities = MAPPER.createArrayNode();
    capabilities.add("timers");
    capabilities.add("unit_conversion");
    m.set("capabilities", capabilities); // array — order is semantic, JCS preserves it

    ArrayNode tools = MAPPER.createArrayNode();
    ObjectNode tool = MAPPER.createObjectNode();
    tool.put("ref", "convert_units");
    ObjectNode config = MAPPER.createObjectNode();
    ArrayNode domains = MAPPER.createArrayNode();
    domains.add("mass");
    domains.add("volume");
    domains.add("temperature");
    config.set("domains", domains);
    config.put("precision", 2); // integer inside a nested config object
    tool.set("config", config);
    tools.add(tool);
    m.set("tools", tools);

    return m;
  }

  @Test
  void goldenVectorRoundTripsAcrossLanguages() throws Exception {
    if (System.getProperty("hp.generate.golden") != null) {
      generateFixture();
      return;
    }

    if (!Files.exists(FIXTURE)) {
      fail(
          "Golden-vector fixture missing at "
              + FIXTURE.toAbsolutePath()
              + " — generate it with:  "
              + GENERATE_CMD);
      return;
    }

    JsonNode golden = MAPPER.readTree(FIXTURE.toFile());
    JsonNode manifest = golden.get("manifest");
    String kid = golden.get("kid").asText();
    String publicKeyB64 = golden.get("package_public_key_b64").asText();

    // (1) Our verifier, trusting exactly the fixture's key, accepts the signed manifest.
    PackageSignatureVerifier verifier = verifierTrusting(kid, publicKeyB64);
    assertThat(verifier.verify(manifest)).isEqualTo(kid);

    // (2) A byte-tampered copy is rejected with the stable mismatch code.
    ObjectNode tampered = (ObjectNode) manifest.deepCopy();
    tampered.put("id", "golden-vector-skill-TAMPERED");
    assertThatThrownBy(() -> verifier.verify(tampered))
        .isInstanceOf(PackageSignatureException.class)
        .satisfies(
            e -> assertThat(((PackageSignatureException) e).code()).isEqualTo("signature_mismatch"));

    // (3) The canonical string the Rust side diffs against still matches our canonicalizer output.
    String recomputed =
        new String(ManifestCanonicalizer.canonicalBytes(manifest), StandardCharsets.UTF_8);
    assertThat(golden.get("jcs_canonical").asText())
        .as("jcs_canonical in the fixture has drifted from ManifestCanonicalizer; regenerate: %s",
            GENERATE_CMD)
        .isEqualTo(recomputed);
  }

  /** Build a verifier trusting a single Ed25519 key (X.509 SPKI base64), as the client would ship. */
  private static PackageSignatureVerifier verifierTrusting(String kid, String publicKeyB64) {
    PackageSigningProperties.Key key = new PackageSigningProperties.Key();
    key.setKid(kid);
    key.setAlg("Ed25519");
    key.setPublicKey(publicKeyB64);
    key.setActive(true);
    return new PackageSignatureVerifier(new PackageTrustedKeySet(List.of(key), 5));
  }

  /**
   * GENERATOR: mint a fresh Ed25519 keypair, sign the fixed manifest through the real {@link
   * PackageSigner} (wired exactly as production does, via {@link PackageSignerConfig} from a package
   * trusted-set that holds the private half), self-check the signature, and (re)write the fixture.
   */
  private static void generateFixture() throws Exception {
    KeyPair kp = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
    String kid = "hp-pkg-golden";
    String publicKeyB64 = Base64.getEncoder().encodeToString(kp.getPublic().getEncoded());
    String privateKeyB64 = Base64.getEncoder().encodeToString(kp.getPrivate().getEncoded());

    PackageSigningProperties.Key signingKey = new PackageSigningProperties.Key();
    signingKey.setKid(kid);
    signingKey.setAlg("Ed25519");
    signingKey.setPublicKey(publicKeyB64);
    signingKey.setPrivateKey(privateKeyB64);
    signingKey.setActive(true);
    PackageTrustedKeySet trusted = new PackageTrustedKeySet(List.of(signingKey), 5);

    // The real production wiring: PackageSignerConfig bridges the trusted-set to the Ed25519 signer.
    PackageSigner packageSigner = new PackageSignerConfig().packageSigner(trusted);

    ObjectNode manifest = fixedManifest();
    PackageSignature sig = packageSigner.sign(manifest);
    manifest.put("signature", sig.signature());
    manifest.put("signing_key_id", sig.signingKeyId());

    // The canonical string (manifest-minus-signature) the Rust verifier diffs byte-for-byte.
    String jcsCanonical =
        new String(ManifestCanonicalizer.canonicalBytes(manifest), StandardCharsets.UTF_8);

    // Self-check before writing: never emit a fixture our own verifier would reject.
    assertThat(verifierTrusting(kid, publicKeyB64).verify(manifest)).isEqualTo(kid);

    ObjectNode golden = MAPPER.createObjectNode();
    golden.set("manifest", manifest);
    golden.put("package_public_key_b64", publicKeyB64);
    golden.put("kid", kid);
    golden.put("jcs_canonical", jcsCanonical);

    Files.createDirectories(FIXTURE.getParent());
    MAPPER.writerWithDefaultPrettyPrinter().writeValue(FIXTURE.toFile(), golden);
  }
}
