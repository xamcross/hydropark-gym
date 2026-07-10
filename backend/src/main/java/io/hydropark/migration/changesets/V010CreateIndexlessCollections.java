package io.hydropark.migration.changesets;

import com.mongodb.MongoCommandException;
import io.hydropark.migration.Migration;
import java.util.List;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.stereotype.Component;

/**
 * Explicitly creates the two collections that no changeset otherwise brings into existence.
 *
 * <p>Every other collection is created as a side effect of {@code createIndex}. These two carry no
 * secondary index on purpose:
 *
 * <ul>
 *   <li>{@code settled_orders} - keyed by {@code _id} = {@code order_id}; the natural PK is the only
 *       lookup, so an extra index would be dead weight on an append-only log.
 *   <li>{@code device_slot_counters} - keyed by {@code _id} = {@code user_id}; the 5-slot cap is an
 *       atomic {@code findOneAndUpdate} point-lookup (§11.1), never a scan.
 * </ul>
 *
 * <p>Relying on MongoDB's implicit creation-on-first-insert would work on an unauthenticated local
 * mongod and then fail in Atlas, where the writing identity needs the {@code createCollection}
 * action. Granting that to the api and worker roles would mean the running tiers can conjure
 * collections - a privilege the whole point of {@code deploy/fly/atlas-roles.js} is to withhold. So
 * the migrator, which is allowed to create collections, creates them once, and the zones only ever
 * write into something that already exists.
 *
 * <p>Idempotent: {@code createCollection} on an existing name is skipped.
 */
@Component
public class V010CreateIndexlessCollections implements Migration {

  private static final List<String> COLLECTIONS = List.of("settled_orders", "device_slot_counters");

  @Override
  public String id() {
    return "V010__create_indexless_collections";
  }

  @Override
  public String description() {
    return "explicitly create settled_orders and device_slot_counters, which carry no index and so "
        + "are never created as a side effect of createIndex";
  }

  /** MongoDB error code for {@code NamespaceExists}. */
  private static final int NAMESPACE_EXISTS = 48;

  @Override
  public void apply(MongoTemplate mongo) {
    for (String name : COLLECTIONS) {
      try {
        mongo.getDb().createCollection(name);
      } catch (MongoCommandException e) {
        // Idempotency by "create, then tolerate NamespaceExists" rather than "check, then create".
        //
        // The obvious `if (!mongo.collectionExists(name))` issues listCollections, which MongoDB
        // authorizes only at the *database* resource level. Asking for it would force the migrator
        // role wider than it needs to be, and it is racy besides: two migrator processes can both
        // observe "absent" and both create. Creating unconditionally and swallowing code 48 needs
        // only `createCollection` on this one collection, and is correct under concurrency.
        if (e.getErrorCode() != NAMESPACE_EXISTS) {
          throw e;
        }
      }
    }
  }
}
