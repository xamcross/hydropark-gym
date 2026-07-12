package io.hydropark.catalog;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.hydropark.certification.CertificationReport;
import io.hydropark.certification.CertificationService;
import io.hydropark.certification.Finding;
import java.io.File;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;

/**
 * P1-22: LAUNCH SKILL CATALOG gate. Every authored manifest under {@code contracts/catalog/} must
 * clear the {@link CertificationService} certification pipeline (SPEC §8.5, P1-20.1) — the same gate
 * the registry runs at submission (schema, referential integrity, budget limits, non-token styling,
 * localization completeness, and the deterministic allergen/food-safety review). This test is the
 * standing proof that the shipped catalog is certifiable content, not just well-intentioned drafts:
 * add a manifest that trips any check and the build fails, naming the manifest, the finding code, and
 * the JSON pointer that broke.
 *
 * <p>Pure JUnit — no Spring context, no Docker. {@link CertificationService}'s no-arg constructor
 * loads the shipped classpath schema ({@code /certification/skill-manifest.schema.json}), which
 * {@code ManifestSchemaInSyncTest} pins to the source-of-truth {@code contracts/skill-manifest.schema.json},
 * so certifying here is equivalent to certifying against the authoritative contract.
 *
 * <p>Not run as part of the authoring change (AGENT-CONTRACT: "Do not run mvn").
 */
class CatalogCertificationTest {

  private static final ObjectMapper MAPPER = new ObjectMapper();

  private final CertificationService service = new CertificationService();

  /**
   * The launch catalog: the exact skill ids P1-22 requires — two free onboarding skills (§26.4) plus
   * eight paid everyday-domain skills (§27.1). Locked so a dropped or renamed manifest fails loudly
   * rather than silently shrinking the catalog.
   */
  private static final Set<String> FREE_IDS = Set.of("kitchen-timer", "packing-list");

  private static final Set<String> PAID_IDS =
      Set.of(
          "cooking-assistant",
          "travel-planner",
          "nutrition-coach",
          "home-diy",
          "garden-plants",
          "car-care",
          "budget-bills",
          "study-flashcards");

  /**
   * Resolves {@code contracts/catalog/}. Surefire runs with the module dir ({@code backend/}) as the
   * working directory, so {@code ../contracts/catalog} is the repo-root catalog; fall back to a
   * repo-root-relative path if a runner sets the working directory differently.
   */
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

  @Test
  void everyCatalogManifestCertifiesPass() throws Exception {
    List<File> files = manifestFiles();

    // manifest id -> human-readable list of the ERROR findings that blocked it (empty = certified).
    TreeMap<String, List<String>> failures = new TreeMap<>();
    Set<String> seenIds = new TreeSet<>();

    for (File f : files) {
      JsonNode manifest;
      try {
        manifest = MAPPER.readTree(f);
      } catch (Exception e) {
        failures.put(f.getName(), List.of("could not parse JSON: " + e.getMessage()));
        continue;
      }

      String id = manifest.path("id").asText(f.getName());
      seenIds.add(id);

      CertificationReport report = service.certify(manifest);
      if (!report.passed()) {
        failures.put(
            id,
            report.errors().stream()
                .map(CatalogCertificationTest::describe)
                .collect(Collectors.toList()));
      }
    }

    assertThat(failures)
        .as(
            "the following catalog manifests failed certification (manifest -> [check_code @ pointer:"
                + " message]); every entry must be empty for the launch catalog to ship:%n%s",
            render(failures))
        .isEmpty();

    // Sanity: the launch catalog is exactly the 2 free + 8 paid skills P1-22 commissions.
    Set<String> expected = new TreeSet<>();
    expected.addAll(FREE_IDS);
    expected.addAll(PAID_IDS);
    assertThat(seenIds)
        .as("catalog ids present under %s", catalogDir().getAbsolutePath())
        .containsAll(expected);
  }

  @Test
  void catalogHasTwoFreeAndEightPaidSkills() throws Exception {
    TreeSet<String> free = new TreeSet<>();
    TreeSet<String> paid = new TreeSet<>();
    for (File f : manifestFiles()) {
      JsonNode m = MAPPER.readTree(f);
      String id = m.path("id").asText(f.getName());
      if (m.path("pricing").path("free").asBoolean(false)) {
        free.add(id);
      } else {
        paid.add(id);
      }
    }
    assertThat(free).as("free skills").containsExactlyInAnyOrderElementsOf(FREE_IDS);
    assertThat(paid).as("paid skills").containsAll(PAID_IDS);
  }

  private static String describe(Finding finding) {
    return finding.code() + " @ " + finding.pointer() + ": " + finding.message();
  }

  private static String render(TreeMap<String, List<String>> failures) {
    if (failures.isEmpty()) {
      return "(none)";
    }
    StringBuilder sb = new StringBuilder();
    failures.forEach(
        (id, errs) -> {
          sb.append("  ").append(id).append(':').append(System.lineSeparator());
          for (String e : errs) {
            sb.append("      - ").append(e).append(System.lineSeparator());
          }
        });
    return sb.toString();
  }
}
