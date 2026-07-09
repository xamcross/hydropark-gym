package io.hydropark.licensing;

import static org.assertj.core.api.Assertions.assertThat;

import com.mongodb.client.MongoClients;
import com.mongodb.client.model.IndexOptions;
import com.mongodb.client.model.Indexes;
import io.hydropark.port.Ports.GrantSource;
import io.hydropark.port.Ports.GrantStatus;
import java.time.Instant;
import java.util.List;
import org.bson.Document;
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
 * {@link GrantService} invariants against a real MongoDB (Testcontainers). Covers the two
 * correctness-critical behaviours from the ticket: order-scoped reversal (bundle survives a
 * standalone refund) and the wallet clawback walk (straddle-in-full + skip-terminal).
 *
 * <p>Not run here (agent contract); requires Docker.
 */
@Testcontainers
class GrantServiceTest {

  @Container static final MongoDBContainer MONGO = new MongoDBContainer("mongo:7.0");

  static MongoTemplate template;
  static GrantRepository grantRepo;
  static GrantService svc;

  private static final String USER = "user_1";

  @BeforeAll
  static void setUp() {
    template = new MongoTemplate(MongoClients.create(MONGO.getReplicaSetUrl()), "hydropark_test");
    grantRepo = new MongoRepositoryFactory(template).getRepository(GrantRepository.class);
    // The correctness-critical index (mirrors migration V005): unique per (order_id, skill_id) makes
    // createGrants idempotent under redelivery via a duplicate-key short-circuit.
    template
        .getCollection("grants")
        .createIndex(
            Indexes.ascending("order_id", "skill_id"),
            new IndexOptions().name("grants_order_id_skill_id_unique").unique(true));
    svc = new GrantService(template, grantRepo);
  }

  @BeforeEach
  void clean() {
    template.remove(new Query(), Grant.class);
    template.getCollection("orders").deleteMany(new Document());
  }

  @Test
  void flipGrantsForOrderLeavesABundleGrantActiveWhenTheStandaloneOrderIsRefunded() {
    // Same skill owned two ways: standalone order O1, and inside bundle order O2.
    grantRepo.save(
        Grant.create("g_standalone", USER, "cooking", GrantSource.STANDALONE, "O1", "mor", "USD", 500, Instant.now()));
    grantRepo.save(
        Grant.create("g_bundle", USER, "cooking", GrantSource.BUNDLE, "O2", "mor", "USD", 500, Instant.now()));

    svc.flipGrantsForOrder("O1", GrantStatus.REFUNDED);

    assertThat(grantRepo.findById("g_standalone")).get().extracting(Grant::getStatus).isEqualTo("refunded");
    assertThat(grantRepo.findById("g_bundle")).get().extracting(Grant::getStatus).isEqualTo("active");
    // Effective ownership survives via the still-active bundle grant (B1).
    assertThat(svc.hasActiveGrant(USER, "cooking")).isTrue();
  }

  @Test
  void clawbackRevokesAStraddlingGrantInFullAndSkipsAlreadyTerminalGrants() {
    Instant now = Instant.now();
    grantRepo.save(Grant.create("g1", USER, "s1", GrantSource.STANDALONE, "o1", "wallet", "USD", 500, now));
    grantRepo.save(Grant.create("g2", USER, "s2", GrantSource.STANDALONE, "o2", "wallet", "USD", 500, now.minusSeconds(1)));
    grantRepo.save(Grant.create("g3", USER, "s3", GrantSource.STANDALONE, "o3", "wallet", "USD", 500, now.minusSeconds(2)));
    // An already-charged-back wallet grant, more recent than g2/g3 - must be skipped, not double-counted.
    grantRepo.save(Grant.create("gt", USER, "s4", GrantSource.STANDALONE, "o4", "wallet", "USD", 500, now.minusMillis(500)));
    template.updateFirst(
        Query.query(Criteria.where("_id").is("gt")),
        new Update().set("status", GrantStatus.CHARGED_BACK.wire()),
        Grant.class);

    // Clawback 700: g1 (500) fully, then g2 (500) straddles the remaining 200 -> revoked in full.
    List<String> revoked = svc.revokeWalletGrantsMostRecentFirst(USER, 700);

    assertThat(revoked).containsExactly("g1", "g2");
    assertThat(grantRepo.findById("g1")).get().extracting(Grant::getStatus).isEqualTo("charged_back");
    assertThat(grantRepo.findById("g2")).get().extracting(Grant::getStatus).isEqualTo("charged_back");
    assertThat(grantRepo.findById("g3")).get().extracting(Grant::getStatus).isEqualTo("active");
    // The pre-terminal grant is untouched (skipped), proving no double-count.
    assertThat(grantRepo.findById("gt")).get().extracting(Grant::getStatus).isEqualTo("charged_back");
  }

  @Test
  void walletFundedGrantCarriesWalletSourceAndIsVisibleToTheClawbackWalk() {
    // A wallet purchase writes an order with payment_source='wallet' (SettlementService.payWithWallet
    // constructs it with PaymentSource.WALLET). createGrants denormalizes that onto the grant.
    template
        .getCollection("orders")
        .insertOne(
            new Document("_id", "ow")
                .append("payment_source", "wallet")
                .append("currency", "USD")
                .append("amount", 500L));

    svc.createGrants(USER, "ow", GrantSource.STANDALONE, List.of("cooking"));

    List<Grant> all = grantRepo.findByOrderId("ow");
    assertThat(all).hasSize(1);
    assertThat(all.get(0).getPaymentSource()).isEqualTo("wallet");

    // The chargeback clawback filters payment_source='wallet' + status='active'. If the denormalized
    // source were ever wrong, this walk would revoke nothing. Prove the grant is reachable by it.
    List<String> revoked = svc.revokeWalletGrantsMostRecentFirst(USER, 500);
    assertThat(revoked).containsExactly(all.get(0).getId());
    assertThat(grantRepo.findById(all.get(0).getId()))
        .get()
        .extracting(Grant::getStatus)
        .isEqualTo("charged_back");
  }

  @Test
  void bundleSplitPutsTheRemainderOnTheFirstMemberAndSumsExactly() {
    template
        .getCollection("orders")
        .insertOne(
            new Document("_id", "ob2")
                .append("payment_source", "mor")
                .append("currency", "USD")
                .append("amount", 1000L)); // 1000 / 3 = 333 r1 -> [334, 333, 333]

    svc.createGrants(USER, "ob2", GrantSource.BUNDLE, List.of("a", "b", "c"));

    List<Grant> all = grantRepo.findByOrderId("ob2");
    assertThat(all).hasSize(3);
    assertThat(priceOf(all, "a")).isEqualTo(334L); // the odd minor unit rides the FIRST member
    assertThat(priceOf(all, "b")).isEqualTo(333L);
    assertThat(priceOf(all, "c")).isEqualTo(333L);
    assertThat(all.stream().mapToLong(Grant::getPriceMinor).sum()).isEqualTo(1000L);
  }

  private static long priceOf(List<Grant> grants, String skillId) {
    return grants.stream()
        .filter(g -> g.getSkillId().equals(skillId))
        .findFirst()
        .orElseThrow()
        .getPriceMinor();
  }

  @Test
  void createGrantsIsIdempotentPerOrderLineAndSplitsBundlePrice() {
    template
        .getCollection("orders")
        .insertOne(
            new Document("_id", "ob")
                .append("payment_source", "mor")
                .append("currency", "USD")
                .append("amount", 3001L));

    svc.createGrants(USER, "ob", GrantSource.BUNDLE, List.of("a", "b", "c"));
    svc.createGrants(USER, "ob", GrantSource.BUNDLE, List.of("a", "b", "c")); // webhook redelivery

    List<Grant> all = grantRepo.findByOrderId("ob");
    assertThat(all).hasSize(3); // unique (order_id, skill_id) short-circuited the redelivery
    assertThat(all).allSatisfy(g -> assertThat(g.getPaymentSource()).isEqualTo("mor"));
    assertThat(all.stream().mapToLong(Grant::getPriceMinor).sum()).isEqualTo(3001L); // exact split
  }
}
