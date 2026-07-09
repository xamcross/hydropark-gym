package io.hydropark.config;

import com.mongodb.ReadConcern;
import com.mongodb.ReadPreference;
import com.mongodb.TransactionOptions;
import com.mongodb.WriteConcern;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.mongodb.MongoDatabaseFactory;
import org.springframework.data.mongodb.MongoTransactionManager;

/**
 * Money and ownership paths (§5.4, §5.5) require multi-document ACID transactions: the wallet debit,
 * the grant write, and the {@code settled_orders} row must commit together or not at all.
 *
 * <p>Mongo only offers transactions on a replica set. That is why docker-compose runs a
 * <em>single-node replica set</em> rather than a standalone mongod - a standalone would let every
 * settlement test pass locally and then fail the moment two writes needed to be atomic.
 *
 * <p>Transactions read/write with majority concern so a settlement can never be rolled back by a
 * primary election after the Issuer has already signed against it.
 */
@Configuration
public class MongoConfig {

  @Bean
  MongoTransactionManager mongoTransactionManager(MongoDatabaseFactory factory) {
    TransactionOptions options =
        TransactionOptions.builder()
            .readConcern(ReadConcern.MAJORITY)
            .writeConcern(WriteConcern.MAJORITY)
            .readPreference(ReadPreference.primary())
            .build();
    return new MongoTransactionManager(factory, options);
  }
}
