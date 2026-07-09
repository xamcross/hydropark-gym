package io.hydropark.licensing;

import static org.assertj.core.api.Assertions.assertThat;

import com.mongodb.client.MongoClients;
import com.mongodb.client.model.IndexOptions;
import com.mongodb.client.model.Indexes;
import io.hydropark.port.Ports.GrantSource;
import java.util.List;
import org.bson.Document;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.data.mongodb.MongoDatabaseFactory;
import org.springframework.data.mongodb.MongoTransactionManager;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.SimpleMongoClientDatabaseFactory;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.repository.support.MongoRepositoryFactory;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.MongoDBContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

/**
 * Pins the claim that {@link GrantService#createGrants} reads the {@code orders} collection by name
 * <em>inside the settlement worker's ambient transaction</em> - i.e. through the same Mongo session,
 * so it sees an order written earlier in that very transaction (read-your-own-write), not just
 * already-committed data.
 *
 * <p>This mirrors {@code SettlementService.payWithWallet}, which inserts the wallet order and then
 * calls {@code createGrants} within one {@code @Transactional} boundary. Here the same is driven
 * explicitly via a {@link TransactionTemplate} over a {@link MongoTransactionManager}; every
 * {@link MongoTemplate} operation inside the callback joins the thread-bound session automatically.
 * If the read did <em>not</em> join the session it would miss the uncommitted order and the grant
 * would fall back to {@code payment_source='unknown'}/{@code price=0} - which the assertions rule out.
 *
 * <p>Not run here (agent contract); requires Docker (a replica set - Testcontainers Mongo is one).
 */
@Testcontainers
class GrantServiceTransactionTest {

  @Container static final MongoDBContainer MONGO = new MongoDBContainer("mongo:7.0");

  static MongoTemplate template;
  static GrantRepository grantRepo;
  static GrantService svc;
  static TransactionTemplate tx;

  private static final String USER = "user_1";

  @BeforeAll
  static void setUp() {
    MongoDatabaseFactory factory =
        new SimpleMongoClientDatabaseFactory(
            MongoClients.create(MONGO.getReplicaSetUrl()), "hydropark_test");
    template = new MongoTemplate(factory);
    grantRepo = new MongoRepositoryFactory(template).getRepository(GrantRepository.class);
    template
        .getCollection("grants")
        .createIndex(
            Indexes.ascending("order_id", "skill_id"),
            new IndexOptions().name("grants_order_id_skill_id_unique").unique(true));
    svc = new GrantService(template, grantRepo);
    tx = new TransactionTemplate(new MongoTransactionManager(factory));
  }

  @BeforeEach
  void clean() {
    template.remove(new Query(), Grant.class);
    template.getCollection("orders").deleteMany(new Document());
  }

  @Test
  void createGrantsReadsAnOrderWrittenEarlierInTheSameAmbientTransaction() {
    tx.executeWithoutResult(
        status ->
            // template.execute(...) hands back a session-bound collection, so this insert is part of
            // the transaction (a raw template.getCollection(...) would auto-commit outside it).
            template.execute(
                "orders",
                collection -> {
                  collection.insertOne(
                      new Document("_id", "otx")
                          .append("payment_source", "wallet")
                          .append("currency", "USD")
                          .append("amount", 500L));
                  // Same transaction: createGrants' findById on "orders" must see this uncommitted row.
                  svc.createGrants(USER, "otx", GrantSource.STANDALONE, List.of("cooking"));
                  return null;
                }));

    List<Grant> all = grantRepo.findByOrderId("otx");
    assertThat(all).hasSize(1);
    // The denormalization read the in-transaction order (not the unknown/0 fallback of a missed read).
    assertThat(all.get(0).getPaymentSource()).isEqualTo("wallet");
    assertThat(all.get(0).getPriceMinor()).isEqualTo(500L);
  }
}
