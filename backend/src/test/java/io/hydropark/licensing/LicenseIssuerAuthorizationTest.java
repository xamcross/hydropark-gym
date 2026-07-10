package io.hydropark.licensing;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.mongodb.client.MongoClients;
import com.mongodb.client.model.Filters;
import com.mongodb.client.model.IndexOptions;
import com.mongodb.client.model.Indexes;
import io.hydropark.common.ApiException;
import io.hydropark.common.ErrorCode;
import io.hydropark.config.AppProperties;
import io.hydropark.port.Ports.DeviceSlotPort;
import io.hydropark.port.Ports.GrantSource;
import io.hydropark.port.Ports.IssuedLicense;
import io.hydropark.port.Ports.SettlementLogPort;
import java.time.Instant;
import java.util.HashSet;
import java.util.Set;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.repository.support.MongoRepositoryFactory;
import org.testcontainers.containers.MongoDBContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

/**
 * The Issuer's authorization keystone (BACKEND-DESIGN §6.2): it signs <b>only</b> when there is an
 * active grant for the <em>exact</em> {@code (user, skill)} whose order has settled - regardless of
 * who called it. These tests pin the two refusal cases the ticket calls out, plus the happy path and
 * idempotent re-issue.
 *
 * <p>Not run here (agent contract); requires Docker.
 */
@Testcontainers
class LicenseIssuerAuthorizationTest {

  @Container static final MongoDBContainer MONGO = new MongoDBContainer("mongo:7.0");

  static MongoTemplate template;
  static GrantRepository grantRepo;
  static LicenseRepository licenseRepo;
  static LicenseAuditRepository auditRepo;
  static AppProperties props;
  static TrustedKeySet keys;
  static LicenseSigner signer;
  static LicenseVerifier verifier;
  static IssuanceRateLimiter rateLimiter;

  private static final String USER = "user_1";

  /** Mutable fake: the settlement log the Issuer independently consults. */
  static final Set<String> settledOrders = new HashSet<>();

  static final SettlementLogPort settlementLog =
      new SettlementLogPort() {
        @Override
        public void recordSettled(String orderId, String userId) {
          settledOrders.add(orderId);
        }

        @Override
        public boolean isSettledOrder(String orderId) {
          return settledOrders.contains(orderId);
        }
      };

  static final DeviceSlotPort deviceSlot =
      new DeviceSlotPort() {
        @Override
        public void assertActiveSlot(String userId, String deviceId) {
          // slot available in tests
        }

        @Override
        public String fingerprintOf(String deviceId) {
          return "fp-" + deviceId;
        }
      };

  static LocalLicenseIssuer issuer;

  @BeforeAll
  static void setUp() {
    template = new MongoTemplate(MongoClients.create(MONGO.getReplicaSetUrl()), "hydropark_test");
    grantRepo = new MongoRepositoryFactory(template).getRepository(GrantRepository.class);
    licenseRepo = new MongoRepositoryFactory(template).getRepository(LicenseRepository.class);
    auditRepo = new MongoRepositoryFactory(template).getRepository(LicenseAuditRepository.class);
    // One-live-license-per-(user, skill, device) partial unique index (mirrors migration V005) - the
    // index the Issuer relies on to keep concurrent re-issue from minting a second active license.
    template
        .getCollection("licenses")
        .createIndex(
            Indexes.ascending("user_id", "skill_id", "device_id"),
            new IndexOptions()
                .name("licenses_active_unique")
                .unique(true)
                .partialFilterExpression(Filters.eq("status", "active")));

    props = LicensingTestKeys.propsWithFreshKey("hp-lic-test");
    keys = new TrustedKeySet(props);
    signer = new LicenseSigner(SignerConfig.jdkSignerFrom(keys), props);
    verifier = new LicenseVerifier(keys, props);
    rateLimiter = new IssuanceRateLimiter(template, props);

    issuer =
        new LocalLicenseIssuer(
            signer, grantRepo, licenseRepo, auditRepo, settlementLog, deviceSlot, rateLimiter);
  }

  @BeforeEach
  void clean() {
    template.remove(new Query(), Grant.class);
    template.remove(new Query(), License.class);
    template.remove(new Query(), LicenseAudit.class);
    settledOrders.clear();
  }

  @Test
  void refusesWhenTheGrantIsActiveButItsOrderIsNotSettled() {
    grantRepo.save(
        Grant.create("g1", USER, "cooking", GrantSource.STANDALONE, "O1", "mor", "USD", 500, Instant.now()));
    // O1 is deliberately NOT in settled_orders.

    assertThatThrownBy(() -> issuer.issue(USER, "cooking", "dev_1"))
        .isInstanceOf(ApiException.class)
        .extracting(e -> ((ApiException) e).errorCode())
        .isEqualTo(ErrorCode.NOT_ENTITLED);
  }

  @Test
  void refusesASkillTheUserOnlyHasASettledOrderForADifferentSkill() {
    // Settled order exists for cooking...
    grantRepo.save(
        Grant.create("g1", USER, "cooking", GrantSource.STANDALONE, "O1", "mor", "USD", 500, Instant.now()));
    settledOrders.add("O1");

    // ...but the request is for gardening, for which there is no active grant at all.
    assertThatThrownBy(() -> issuer.issue(USER, "gardening", "dev_1"))
        .isInstanceOf(ApiException.class)
        .extracting(e -> ((ApiException) e).errorCode())
        .isEqualTo(ErrorCode.NOT_ENTITLED);
  }

  @Test
  void mintsAVerifiableTokenWhenTheExactPairHasSettledAndReIssueIsIdempotent() {
    grantRepo.save(
        Grant.create("g1", USER, "cooking", GrantSource.STANDALONE, "O1", "mor", "USD", 500, Instant.now()));
    settledOrders.add("O1");

    IssuedLicense lic = issuer.issue(USER, "cooking", "dev_1");

    // The token verifies against the trusted key set, with server-derived binding.
    LicensePayload p = verifier.verify(lic.token());
    assertThat(p.sub()).isEqualTo(USER);
    assertThat(p.skillId()).isEqualTo("cooking");
    assertThat(p.deviceId()).isEqualTo("dev_1");
    assertThat(p.deviceBinding()).isEqualTo("fp-dev_1");

    // One license row, one audit row.
    assertThat(licenseRepo.findByUserIdAndSkillIdAndDeviceIdAndStatus(USER, "cooking", "dev_1", "active"))
        .isPresent();
    assertThat(auditRepo.count()).isEqualTo(1);

    // Idempotent re-issue returns the same token, mints nothing new.
    IssuedLicense again = issuer.issue(USER, "cooking", "dev_1");
    assertThat(again.licenseId()).isEqualTo(lic.licenseId());
    assertThat(again.token()).isEqualTo(lic.token());
    assertThat(licenseRepo.count()).isEqualTo(1);
    assertThat(auditRepo.count()).isEqualTo(1);
  }
}
