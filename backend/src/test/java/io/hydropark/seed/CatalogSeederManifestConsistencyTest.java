package io.hydropark.seed;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.hydropark.seed.CatalogSeeder.SkillSeed;
import java.io.File;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import org.bson.Document;
import org.junit.jupiter.api.Test;

/**
 * Locks {@link CatalogSeeder}'s hardcoded dev catalog to the certified manifests under {@code
 * contracts/catalog/} — the catalog of record (P1-22). The seeder had drifted: it seeded
 * provisional ids {@code cleaning-schedule} and {@code pet-care} instead of the certified {@code
 * budget-bills} and {@code study-flashcards}, and several {@code compressed_prompt} values did not
 * match their manifest. This test pins id set, {@code free} flag, price, and {@code
 * compressed_prompt} to the manifests, and pins the SF8 "never seed {@code system_prompt}" rule.
 *
 * <p>Pure JUnit — no Spring context, no Docker. {@link CatalogSeeder} is instantiated directly
 * with a {@code null} {@code MongoTemplate}: {@link CatalogSeeder#catalog()} and {@link
 * CatalogSeeder#buildSkillDocument} never touch the {@code mongo} field, only the collection-write
 * methods (not exercised here) do.
 *
 * <p>Manifest loading mirrors {@code io.hydropark.catalog.CatalogCertificationTest} exactly:
 * surefire's working directory is the module dir ({@code backend/}), so {@code ../contracts/catalog}
 * resolves to the repo-root catalog, with a repo-root-relative fallback.
 */
class CatalogSeederManifestConsistencyTest {

  private static final ObjectMapper MAPPER = new ObjectMapper();

  /** See {@code CatalogCertificationTest#catalogDir()} — same resolution, same rationale. */
  private static File catalogDir() {
    File fromModule = new File("../contracts/catalog");
    if (fromModule.isDirectory()) {
      return fromModule;
    }
    File fromRoot = new File("contracts/catalog");
    if (fromRoot.isDirectory()) {
      return fromRoot;
    }
    throw new AssertionError(
        "contracts/catalog not found. Tried "
            + fromModule.getAbsolutePath()
            + " and "
            + fromRoot.getAbsolutePath()
            + ". This test assumes surefire's working directory is the module dir (backend/).");
  }

  private static List<File> manifestFiles() {
    File dir = catalogDir();
    File[] files = dir.listFiles((d, n) -> n.endsWith(".manifest.json"));
    assertThat(files)
        .as("no *.manifest.json files under %s", dir.getAbsolutePath())
        .isNotNull()
        .isNotEmpty();
    List<File> list = new ArrayList<>(Arrays.asList(files));
    list.sort(java.util.Comparator.comparing(File::getName));
    return list;
  }

  /** The manifest-derived fields the seeder must agree with, keyed by manifest {@code id}. */
  private record ManifestExpectation(
      boolean free, long priceMinor, String compressedPrompt, Set<String> capabilities) {}

  /**
   * Reads every certified manifest's {@code id}, {@code pricing.free}, price (minor units), {@code
   * persona.compressed_prompt}, and top-level {@code capabilities} token array (F05 — the
   * install-time capability-disclosure source, SPEC §8.5/§11). Accepts either pricing shape the
   * schema allows for a paid skill — {@code pricing.price.amount_minor} (what every current
   * manifest uses) or the {@code pricing.price_usd} shorthand — so this test does not silently pass
   * if a future manifest is authored with the shorthand form.
   */
  private static Map<String, ManifestExpectation> loadManifestExpectations() throws Exception {
    Map<String, ManifestExpectation> byId = new TreeMap<>();
    for (File f : manifestFiles()) {
      JsonNode manifest = MAPPER.readTree(f);
      String id = manifest.path("id").asText(f.getName());

      JsonNode pricing = manifest.path("pricing");
      boolean free = pricing.path("free").asBoolean(false);

      long priceMinor = 0L;
      if (!free) {
        JsonNode price = pricing.path("price");
        if (price.has("amount_minor")) {
          priceMinor = price.path("amount_minor").asLong();
        } else if (pricing.has("price_usd")) {
          priceMinor = Math.round(pricing.path("price_usd").asDouble() * 100.0);
        } else {
          throw new AssertionError(
              "manifest " + id + " is paid but declares neither pricing.price nor pricing.price_usd");
        }
      }

      String compressedPrompt = manifest.path("persona").path("compressed_prompt").asText(null);
      assertThat(compressedPrompt)
          .as("persona.compressed_prompt for manifest %s", id)
          .isNotBlank();

      Set<String> capabilities = new TreeSet<>();
      manifest.path("capabilities").forEach(node -> capabilities.add(node.asText()));
      assertThat(capabilities).as("capabilities for manifest %s", id).isNotEmpty();

      byId.put(id, new ManifestExpectation(free, priceMinor, compressedPrompt, capabilities));
    }
    return byId;
  }

  private static List<SkillSeed> seederCatalog() {
    // The mongo field is never touched by catalog() or buildSkillDocument() — only the
    // collection-write seedXxx() methods (not exercised by this pure-JUnit test) touch it.
    return new CatalogSeeder(null).catalog();
  }

  @Test
  void seederSkillIdsExactlyMatchTheCertifiedManifestSet() throws Exception {
    Set<String> manifestIds = new TreeSet<>(loadManifestExpectations().keySet());

    Set<String> seederIds = new TreeSet<>();
    for (SkillSeed s : seederCatalog()) {
      seederIds.add(s.id());
    }

    // Locks the launch catalog (SPEC §26.4/§27.1, P1-22): 2 free + 8 paid, no more, no less, and
    // in particular no leftover cleaning-schedule/pet-care provisional ids and no missing
    // budget-bills/study-flashcards.
    assertThat(seederIds)
        .as("CatalogSeeder skill ids vs. certified contracts/catalog manifest ids")
        .containsExactlyInAnyOrderElementsOf(manifestIds);
  }

  @Test
  void everySeederEntryMatchesItsManifestOnFreePriceAndCompressedPrompt() throws Exception {
    Map<String, ManifestExpectation> manifests = loadManifestExpectations();

    for (SkillSeed s : seederCatalog()) {
      ManifestExpectation expected = manifests.get(s.id());
      assertThat(expected)
          .as("seeder id '%s' has no certified manifest under %s", s.id(), catalogDir())
          .isNotNull();

      assertThat(s.free()).as("%s: free flag", s.id()).isEqualTo(expected.free());
      assertThat(s.basePriceMinor())
          .as("%s: price (minor units)", s.id())
          .isEqualTo(expected.priceMinor());
      assertThat(s.compressedPrompt())
          .as("%s: compressed_prompt must equal persona.compressed_prompt verbatim", s.id())
          .isEqualTo(expected.compressedPrompt());
    }
  }

  @Test
  void everySeederEntryExposesExactlyItsManifestCapabilities() throws Exception {
    // F05: the install-time capability-disclosure dialog derives its "This skill can: …" summary
    // from the skills document's capabilities field, ultimately sourced from CatalogService -
    // this pins the seeder's half of that path to the certified manifests' top-level
    // `capabilities` token array so a real skill never discloses an empty/stale set.
    Map<String, ManifestExpectation> manifests = loadManifestExpectations();

    for (SkillSeed s : seederCatalog()) {
      ManifestExpectation expected = manifests.get(s.id());
      assertThat(expected)
          .as("seeder id '%s' has no certified manifest under %s", s.id(), catalogDir())
          .isNotNull();

      assertThat(s.capabilities())
          .as("%s: capabilities", s.id())
          .isNotEmpty()
          .containsExactlyInAnyOrderElementsOf(expected.capabilities());
    }
  }

  @Test
  void seededSkillDocumentsNeverCarrySystemPrompt() {
    // SF8: the full persona (system_prompt) is paid IP that lives only inside the signed
    // .hpskill package. Mongo — and therefore this seeder's output — must only ever hold
    // compressed_prompt. Exercises the actual document-building code path (buildSkillDocument),
    // not just the SkillSeed record shape, so a stray .append("system_prompt", ...) added
    // directly to that method would fail this test even without changing SkillSeed.
    for (SkillSeed s : seederCatalog()) {
      Document doc = CatalogSeeder.buildSkillDocument(s, Instant.now());

      assertThat(doc.keySet())
          .as("skills document for '%s' must never carry a system_prompt key (SF8)", s.id())
          .doesNotContain("system_prompt");

      assertThat(doc.containsKey("preview_transcript_uri"))
          .as("%s: preview_transcript_uri key must still be present (Task 17 fills it)", s.id())
          .isTrue();
      assertThat(doc.get("preview_transcript_uri"))
          .as("%s: preview_transcript_uri must be null in seed data", s.id())
          .isNull();

      assertThat(doc.getString("compressed_prompt"))
          .as("%s: document compressed_prompt must equal the SkillSeed value", s.id())
          .isEqualTo(s.compressedPrompt());

      assertThat(doc.get("capabilities"))
          .as("%s: document capabilities must equal the SkillSeed value (F05)", s.id())
          .isEqualTo(s.capabilities());
    }
  }
}
