package io.hydropark.licensing;

import static org.assertj.core.api.Assertions.assertThat;

import com.mongodb.client.MongoClients;
import com.mongodb.client.model.Filters;
import com.mongodb.client.model.IndexOptions;
import com.mongodb.client.model.Indexes;
import io.hydropark.config.AppProperties;
import io.hydropark.licensing.RollingKeyReissuer.KeyCoverage;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.core.query.Update;
import org.springframework.data.mongodb.repository.support.MongoRepositoryFactory;
import org.testcontainers.containers.MongoDBContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

/**
 * The removal gate for key roll-off (BACKEND-DESIGN §6.3): {@code coverageForKid} must report
 * {@code safeToRemove=false} while any active license still cites a {@code kid}, and the proactive
 * re-issue must move an already-rolled-off license onto the active key so the old {@code kid} becomes
 * safe to drop from shipped builds.
 *
 * <p>Not run here (agent contract); requires Docker.
 */
@Testcontainers
class RollingKeyReissuerCoverageTest {

  @Container static final MongoDBContainer MONGO = new MongoDBContainer("mongo:7.0");

  static MongoTemplate template;
  static LicenseRepository licenseRepo;
  static LicenseAuditRepository auditRepo;
  static TrustedKeySet keys;
  static LicenseSigner signer;
  static RollingKeyReissuer reissuer;

  private static final String ROLLED_OFF_KID = "hp-lic-rolled-off";

  @BeforeAll
  static void setUp() {
    template = new MongoTemplate(MongoClients.create(MONGO.getReplicaSetUrl()), "hydropark_test");
    licenseRepo = new MongoRepositoryFactory(template).getRepository(LicenseRepository.class);
    auditRepo = new MongoRepositoryFactory(template).getRepository(LicenseAuditRepository.class);

    // Mirror V005's one-live-license-per-(user, skill, device) partial-unique index so the
    // supersede-then-insert re-issue behaves exactly as in production.
    template
        .getCollection("licenses")
        .createIndex(
            Indexes.ascending("user_id", "skill_id", "device_id"),
            new IndexOptions()
                .name("licenses_active_unique")
                .unique(true)
                .partialFilterExpression(Filters.eq("status", "active")));

    AppProperties props = LicensingTestKeys.propsWithFreshKey("hp-lic-active");
    keys = new TrustedKeySet(props);
    signer = new LicenseSigner(keys, props);
    reissuer = new RollingKeyReissuer(keys, signer, licenseRepo, auditRepo, template);
  }

  @BeforeEach
  void clean() {
    template.remove(new Query(), License.class);
    template.remove(new Query(), LicenseAudit.class);
  }

  @Test
  void coverageIsUnsafeWhileAnActiveLicenseCitesTheKidAndSafeOnceSuperseded() {
    licenseRepo.insert(
        License.active("lic_1", "user_1", "cooking", "dev_1", ROLLED_OFF_KID, "tok", Instant.now()));

    KeyCoverage before = reissuer.coverageForKid(ROLLED_OFF_KID);
    assertThat(before.remainingActiveLicenses()).isEqualTo(1);
    assertThat(before.safeToRemove()).isFalse();

    // Superseding it (what re-issue does) removes the last active row citing the kid.
    template.updateFirst(
        Query.query(Criteria.where("_id").is("lic_1")),
        new Update().set("status", "superseded"),
        License.class);

    KeyCoverage after = reissuer.coverageForKid(ROLLED_OFF_KID);
    assertThat(after.remainingActiveLicenses()).isZero();
    assertThat(after.safeToRemove()).isTrue();
  }

  @Test
  void reissueMovesAnOutOfWindowLicenseOntoTheActiveKeyAndMakesTheOldKidSafeToRemove() {
    // A real, parseable token (its payload is what re-issue re-signs; the token's own header kid is
    // irrelevant). Store it as if signed by a kid that has already rolled out of the trusted window.
    LicenseSigner.Signed real = signer.sign("lic_old", "user_1", "cooking", "dev_1", "fp-dev_1");
    licenseRepo.insert(
        License.active(
            "lic_old", "user_1", "cooking", "dev_1", ROLLED_OFF_KID, real.token(), Instant.now()));
    assertThat(reissuer.coverageForKid(ROLLED_OFF_KID).safeToRemove()).isFalse();

    int reissued = reissuer.reissueForRollingKey();

    assertThat(reissued).isEqualTo(1);
    // Old row superseded; the rolled-off kid now covers zero active licenses -> safe to remove.
    assertThat(licenseRepo.findById("lic_old"))
        .get()
        .extracting(License::getStatus)
        .isEqualTo("superseded");
    assertThat(reissuer.coverageForKid(ROLLED_OFF_KID).safeToRemove()).isTrue();

    // A fresh active license now exists under the active key, bindings preserved verbatim.
    List<License> underActive =
        licenseRepo.findByStatusAndSigningKeyId("active", keys.active().kid());
    assertThat(underActive).hasSize(1);
    assertThat(underActive.get(0).getSkillId()).isEqualTo("cooking");
    assertThat(underActive.get(0).getDeviceId()).isEqualTo("dev_1");
    // The re-sign was audited as a maintenance re-issue (excluded from the user's rate budget).
    assertThat(auditRepo.count()).isEqualTo(1);
  }
}
