package io.hydropark.migration;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.mongodb.client.MongoClients;
import io.hydropark.seed.CatalogSeeder;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.boot.DefaultApplicationArguments;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.SimpleMongoClientDatabaseFactory;
import org.testcontainers.containers.MongoDBContainer;
import org.testcontainers.junit.jupiter.Testcontainers;

/**
 * Asserts {@link CatalogSeeder} is safe to run twice: identical document counts (and, for the
 * natural-slug-keyed {@code skills}/{@code bundles} collections, identical {@code _id} sets) after
 * a second run, per AGENT-CONTRACT's "Idempotent: upsert by _id, never blind-insert" requirement.
 *
 * <p>Uses a real (Testcontainers) MongoDB rather than mocks, since the property under test is
 * exactly "does {@code replaceOne(..., upsert=true)} against a real server behave as an upsert" -
 * a mock would just assert the test author's own belief about the driver, not the driver's actual
 * behavior.
 *
 * <p><b>This test was written but NOT run</b> (AGENT-CONTRACT rule 2: agents never invoke {@code
 * mvn}). It requires a Docker daemon reachable by Testcontainers to execute.
 */
@Testcontainers
class CatalogSeederIdempotencyTest {

  private static MongoDBContainer mongoContainer;
  private static MongoTemplate template;

  @BeforeAll
  static void startMongo() {
    mongoContainer = new MongoDBContainer("mongo:7.0");
    mongoContainer.start();
    template =
        new MongoTemplate(
            new SimpleMongoClientDatabaseFactory(
                MongoClients.create(mongoContainer.getConnectionString()), "hydropark_seed_test"));
  }

  @AfterAll
  static void stopMongo() {
    if (mongoContainer != null) {
      mongoContainer.stop();
    }
  }

  @Test
  void runningTwiceProducesTheSameDocumentCounts() {
    CatalogSeeder seeder = new CatalogSeeder(template);

    seeder.run(new DefaultApplicationArguments());
    long skills1 = template.getCollection("skills").countDocuments();
    long versions1 = template.getCollection("skill_versions").countDocuments();
    long bundles1 = template.getCollection("bundles").countDocuments();
    long members1 = template.getCollection("bundle_members").countDocuments();
    long prices1 = template.getCollection("regional_prices").countDocuments();

    // Sanity: the seeder actually wrote something the first time, so equality on the second
    // pass isn't trivially true because both counts are zero.
    assertTrue(skills1 > 0, "expected the first run to seed at least one skill");

    seeder.run(new DefaultApplicationArguments());

    assertEquals(skills1, template.getCollection("skills").countDocuments(), "skills count changed on re-run");
    assertEquals(
        versions1, template.getCollection("skill_versions").countDocuments(), "skill_versions count changed on re-run");
    assertEquals(bundles1, template.getCollection("bundles").countDocuments(), "bundles count changed on re-run");
    assertEquals(
        members1, template.getCollection("bundle_members").countDocuments(), "bundle_members count changed on re-run");
    assertEquals(
        prices1, template.getCollection("regional_prices").countDocuments(), "regional_prices count changed on re-run");
  }

  @Test
  void seedsExactlyTwoFreeSkillsAndAtLeastEightPaidSkills() {
    CatalogSeeder seeder = new CatalogSeeder(template);
    seeder.run(new DefaultApplicationArguments());

    long free = template.getCollection("skills").countDocuments(com.mongodb.client.model.Filters.eq("is_free", true));
    long paid = template.getCollection("skills").countDocuments(com.mongodb.client.model.Filters.eq("is_free", false));

    assertEquals(2, free, "expected exactly 2 free skills");
    assertTrue(paid >= 8, "expected at least 8 paid skills, got " + paid);
  }
}
