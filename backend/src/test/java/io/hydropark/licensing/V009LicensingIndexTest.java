package io.hydropark.licensing;

import static org.assertj.core.api.Assertions.assertThat;

import com.mongodb.client.MongoClients;
import io.hydropark.migration.changesets.V005CreateLicensingIndexes;
import io.hydropark.migration.changesets.V009CreateLicenseAuditIndexes;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.bson.Document;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.testcontainers.containers.MongoDBContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

/**
 * Pins the V009 fix: the {@code license_audit} indexes must match the exact key order the
 * {@link IssuanceRateLimiter} queries on, and V005's phantom {@code (user_id, skill_id, created_at)}
 * index (fields the entity never writes) must be gone so the primary per-{@code sub} limit is an
 * index scan, never a collection scan.
 *
 * <p>Applies V005 then V009 in order (as production does) against a real MongoDB, so the test proves
 * the fix-forward: V005 creates the phantom index, V009 drops it and adds the real ones.
 *
 * <p>Not run here (agent contract); requires Docker.
 */
@Testcontainers
class V009LicensingIndexTest {

  @Container static final MongoDBContainer MONGO = new MongoDBContainer("mongo:7.0");

  static MongoTemplate template;

  @BeforeAll
  static void setUp() {
    template = new MongoTemplate(MongoClients.create(MONGO.getReplicaSetUrl()), "hydropark_test");
    new V005CreateLicensingIndexes().apply(template);
    new V009CreateLicenseAuditIndexes().apply(template);
  }

  private static Map<String, Document> indexKeysByName(String collection) {
    Map<String, Document> byName = new HashMap<>();
    for (Document ix : template.getCollection(collection).listIndexes()) {
      byName.put(ix.getString("name"), (Document) ix.get("key"));
    }
    return byName;
  }

  @Test
  void dropsTheV005PhantomAuditIndexAndCreatesTheRateLimiterIndexesInTheRightKeyOrder() {
    Map<String, Document> audit = indexKeysByName("license_audit");

    // The V005 index keyed on user_id/created_at (which LicenseAudit does not have) is dropped.
    assertThat(audit).doesNotContainKey("license_audit_user_skill_created_idx");

    // Primary control: (sub, caller, at) - two equalities then the range, the limiter's exact shape.
    assertThat(audit).containsKey("license_audit_sub_caller_at_idx");
    assertThat(new ArrayList<>(audit.get("license_audit_sub_caller_at_idx").keySet()))
        .containsExactly("sub", "caller", "at");

    // Global backstop: (at) only.
    assertThat(audit).containsKey("license_audit_at_idx");
    assertThat(new ArrayList<>(audit.get("license_audit_at_idx").keySet())).containsExactly("at");
  }

  @Test
  void createsTheLicensesUserIdIdIndexForCursorPagination() {
    Map<String, Document> licenses = indexKeysByName("licenses");
    assertThat(licenses).containsKey("licenses_user_id_id_idx");
    assertThat(new ArrayList<>(licenses.get("licenses_user_id_id_idx").keySet()))
        .containsExactly("user_id", "_id");
  }

  @Test
  void thePrimaryPerSubRateLimitQueryWinsWithTheNewIndexNotACollectionScan() {
    Instant now = Instant.now();
    List<Document> rows = new ArrayList<>();
    // Enough non-matching noise that a collection scan is clearly more expensive than an index scan,
    // so the multi-planner does not pick COLLSCAN just because the collection is tiny.
    for (int i = 0; i < 300; i++) {
      rows.add(
          new Document("_id", "noise_" + i)
              .append("sub", "other_" + i)
              .append("caller", IssuanceRateLimiter.CALLER_ISSUE)
              .append("skill_id", "cooking")
              .append("at", Date.from(now)));
    }
    for (int i = 0; i < 5; i++) {
      rows.add(
          new Document("_id", "u1_" + i)
              .append("sub", "user_1")
              .append("caller", IssuanceRateLimiter.CALLER_ISSUE)
              .append("skill_id", "cooking")
              .append("at", Date.from(now)));
    }
    template.getCollection("license_audit").insertMany(rows);

    // Exactly the primary per-sub filter: sub= AND caller= (equality) AND at>= (range). Selective
    // (5 of 305), so the (sub, caller, at) index wins decisively.
    Document perUser =
        new Document("sub", "user_1")
            .append("caller", IssuanceRateLimiter.CALLER_ISSUE)
            .append("at", new Document("$gte", Date.from(now.minusSeconds(3600))));
    String perUserWinning = winningPlanJson(perUser);
    assertThat(perUserWinning).contains("license_audit_sub_caller_at_idx");
    assertThat(perUserWinning).doesNotContain("COLLSCAN");

    // The global backstop filter (at>= only) is served by the (at) index. On this artificial dataset
    // the window matches every row, so we assert only that the (at) index is applicable to the query
    // shape (a candidate plan) - in production the recent-window is selective and it wins outright.
    Document global = new Document("at", new Document("$gte", Date.from(now.minusSeconds(60))));
    String globalExplain =
        template.getCollection("license_audit").find(global).explain().toJson();
    assertThat(globalExplain).contains("license_audit_at_idx");
  }

  /** The winning plan only (rejected candidates, which may include a COLLSCAN, are excluded). */
  private static String winningPlanJson(Document filter) {
    Document explain = template.getCollection("license_audit").find(filter).explain();
    Document queryPlanner = (Document) explain.get("queryPlanner");
    Document winningPlan = (Document) queryPlanner.get("winningPlan");
    return winningPlan.toJson();
  }
}
