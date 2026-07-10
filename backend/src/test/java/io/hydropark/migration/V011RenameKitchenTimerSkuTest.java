package io.hydropark.migration;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

import com.mongodb.client.MongoClients;
import com.mongodb.client.model.Filters;
import io.hydropark.migration.changesets.V011RenameKitchenTimerSku;
import java.time.Instant;
import org.bson.Document;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.SimpleMongoClientDatabaseFactory;
import org.testcontainers.containers.MongoDBContainer;
import org.testcontainers.junit.jupiter.Testcontainers;

/**
 * Exercises {@link V011RenameKitchenTimerSku} against a real (Testcontainers) MongoDB: seeds the
 * <em>old</em> slug across the collections that carry it - including the two shapes that matter, a
 * {@code skill_versions} row whose composite {@code _id} embeds the slug and a UUIDv7-keyed
 * {@code grants} row whose {@code _id} does not - runs the changeset, and asserts the new slug is
 * present everywhere and the old slug is gone <em>everywhere, including inside composite
 * {@code _id}s</em>. Then runs it a second time and asserts a clean no-op.
 *
 * <p>A real server (not a mock) is essential here: the property under test is precisely that a slug
 * living in {@code _id} cannot be {@code $set} and must be copy-deleted, and that the unique catalog
 * indexes tolerate the transient two-document window. A mock would only assert the author's belief.
 */
@Testcontainers
class V011RenameKitchenTimerSkuTest {

  private static final String OLD_ID = "kitchen-timer-units";
  private static final String NEW_ID = "kitchen-timer";

  private static MongoDBContainer mongoContainer;
  private static MongoTemplate template;

  @BeforeAll
  static void startMongo() {
    mongoContainer = new MongoDBContainer("mongo:7.0");
    mongoContainer.start();
    template =
        new MongoTemplate(
            new SimpleMongoClientDatabaseFactory(
                MongoClients.create(mongoContainer.getConnectionString()), "hydropark_v011_test"));
  }

  @AfterAll
  static void stopMongo() {
    if (mongoContainer != null) {
      mongoContainer.stop();
    }
  }

  @BeforeEach
  void clean() {
    for (String c :
        new String[] {
          "skills", "skill_versions", "bundle_members", "regional_prices",
          "grants", "licenses", "license_audit"
        }) {
      template.getCollection(c).deleteMany(new Document());
    }
  }

  /** Writes a database in the state the OLD-slug seed would have produced, plus licensing rows. */
  private void seedOldSlugState() {
    Instant now = Instant.now();

    template
        .getCollection("skills")
        .insertOne(
            new Document("_id", OLD_ID)
                .append("name", "Kitchen Timer & Units")
                .append("category", "kitchen")
                .append("is_free", true)
                .append("status", "published")
                .append("base_price", 0L)
                .append("base_currency", "USD")
                .append("created_at", now)
                .append("updated_at", now));

    // Composite _id embeds the slug -> "kitchen-timer-units@1.0.0".
    template
        .getCollection("skill_versions")
        .insertOne(
            new Document("_id", OLD_ID + "@1.0.0")
                .append("skill_id", OLD_ID)
                .append("version", "1.0.0")
                .append("is_current", true)
                .append("package_uri", "skills/" + OLD_ID + "/1.0.0/package.hpskill")
                .append("status", "published")
                .append("created_at", now));

    // Composite _id embeds the slug -> "skill:kitchen-timer-units:US".
    template
        .getCollection("regional_prices")
        .insertOne(
            new Document("_id", "skill:" + OLD_ID + ":US")
                .append("target_type", "skill")
                .append("target_id", OLD_ID)
                .append("region", "US")
                .append("price", 0L)
                .append("currency", "USD"));

    // UUIDv7-keyed: _id does NOT embed the slug, so only the skill_id field should change.
    template
        .getCollection("grants")
        .insertOne(
            new Document("_id", "0192f0aa-0000-7000-8000-000000000001")
                .append("order_id", "order-1")
                .append("user_id", "user-1")
                .append("skill_id", OLD_ID)
                .append("status", "active"));
  }

  private long countOldSlugAnywhere() {
    long n = 0;
    n += template.getCollection("skills").countDocuments(Filters.eq("_id", OLD_ID));
    // Any doc still carrying the old slug in a field OR inside a composite _id.
    n += template.getCollection("skill_versions").countDocuments(Filters.eq("skill_id", OLD_ID));
    n += template.getCollection("skill_versions").countDocuments(Filters.eq("_id", OLD_ID + "@1.0.0"));
    n += template.getCollection("regional_prices").countDocuments(Filters.eq("target_id", OLD_ID));
    n += template.getCollection("regional_prices").countDocuments(Filters.eq("_id", "skill:" + OLD_ID + ":US"));
    n += template.getCollection("grants").countDocuments(Filters.eq("skill_id", OLD_ID));
    return n;
  }

  @Test
  void renamesOldSlugEverywhereAndReKeysCompositeIds() {
    seedOldSlugState();

    new V011RenameKitchenTimerSku().apply(template);

    // skills: re-keyed.
    assertNull(
        template.getCollection("skills").find(Filters.eq("_id", OLD_ID)).first(),
        "old skills._id should be gone");
    assertNotNull(
        template.getCollection("skills").find(Filters.eq("_id", NEW_ID)).first(),
        "new skills._id should exist");

    // skill_versions: composite _id re-keyed AND field renamed.
    assertNull(
        template.getCollection("skill_versions").find(Filters.eq("_id", OLD_ID + "@1.0.0")).first(),
        "stale composite skill_versions._id should be gone");
    Document version =
        template.getCollection("skill_versions").find(Filters.eq("_id", NEW_ID + "@1.0.0")).first();
    assertNotNull(version, "skill_versions should be re-keyed to the new composite _id");
    assertEquals(NEW_ID, version.getString("skill_id"), "skill_versions.skill_id should be renamed");

    // regional_prices: composite _id re-keyed AND target_id renamed.
    assertNull(
        template
            .getCollection("regional_prices")
            .find(Filters.eq("_id", "skill:" + OLD_ID + ":US"))
            .first(),
        "stale composite regional_prices._id should be gone");
    Document price =
        template
            .getCollection("regional_prices")
            .find(Filters.eq("_id", "skill:" + NEW_ID + ":US"))
            .first();
    assertNotNull(price, "regional_prices should be re-keyed to the new composite _id");
    assertEquals(NEW_ID, price.getString("target_id"), "regional_prices.target_id should be renamed");

    // grants: UUIDv7 _id unchanged, field renamed in place.
    Document grant =
        template
            .getCollection("grants")
            .find(Filters.eq("_id", "0192f0aa-0000-7000-8000-000000000001"))
            .first();
    assertNotNull(grant, "grants _id (UUIDv7) must NOT be re-keyed");
    assertEquals(NEW_ID, grant.getString("skill_id"), "grants.skill_id should be renamed in place");

    // The old slug survives nowhere, in a field or inside any composite _id.
    assertEquals(0, countOldSlugAnywhere(), "old slug should not appear anywhere after rename");
  }

  @Test
  void secondRunIsANoOp() {
    seedOldSlugState();
    V011RenameKitchenTimerSku migration = new V011RenameKitchenTimerSku();

    migration.apply(template);

    long skills1 = template.getCollection("skills").countDocuments();
    long versions1 = template.getCollection("skill_versions").countDocuments();
    long prices1 = template.getCollection("regional_prices").countDocuments();
    long grants1 = template.getCollection("grants").countDocuments();

    // Re-run: guard sees no old skills._id and returns immediately; nothing changes.
    migration.apply(template);

    assertEquals(skills1, template.getCollection("skills").countDocuments(), "skills count changed on re-run");
    assertEquals(
        versions1, template.getCollection("skill_versions").countDocuments(), "skill_versions count changed on re-run");
    assertEquals(
        prices1, template.getCollection("regional_prices").countDocuments(), "regional_prices count changed on re-run");
    assertEquals(grants1, template.getCollection("grants").countDocuments(), "grants count changed on re-run");

    assertNotNull(
        template.getCollection("skills").find(Filters.eq("_id", NEW_ID)).first(),
        "new slug should still be present after a second run");
    assertEquals(0, countOldSlugAnywhere(), "old slug should still appear nowhere after a second run");
  }

  @Test
  void noOpOnDatabaseSeededFreshWithNewSlug() {
    // Only the new slug exists; the migration must not touch anything.
    Instant now = Instant.now();
    template
        .getCollection("skills")
        .insertOne(new Document("_id", NEW_ID).append("name", "Kitchen Timer & Units").append("created_at", now));

    new V011RenameKitchenTimerSku().apply(template);

    assertNotNull(
        template.getCollection("skills").find(Filters.eq("_id", NEW_ID)).first(),
        "new slug should be untouched");
    assertEquals(1, template.getCollection("skills").countDocuments(), "no document should be created or removed");
  }
}
