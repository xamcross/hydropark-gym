package io.hydropark.migration.changesets;

import com.mongodb.client.model.IndexOptions;
import com.mongodb.client.model.Indexes;
import io.hydropark.migration.Migration;
import java.util.concurrent.TimeUnit;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.stereotype.Component;

/**
 * Indexes for the commerce collections (BACKEND-DESIGN §3.3/§3.6): {@code orders}, {@code
 * webhook_events}, {@code settled_orders}, {@code idempotency_keys}.
 *
 * <p>Two of these carry hard correctness properties:
 *
 * <ul>
 *   <li>{@code webhook_events.provider_event_id} unique - this is THE mechanism behind
 *       insert-first webhook dedupe (B2/B6, AGENT-CONTRACT rule 3). Without it, a redelivered
 *       payment-succeeded event grants a skill twice.
 *   <li>{@code orders.mor_order_id} unique + sparse - the field is NULL until the first webhook
 *       (write-once, B2), so the index must ignore documents where it does not yet exist rather
 *       than treating every pending order as colliding on a shared null.
 * </ul>
 *
 * <p>{@code settled_orders} deliberately gets NO extra index: its Postgres PK IS {@code
 * order_id}, and by AGENT-CONTRACT convention that becomes the Mongo {@code _id} directly, so
 * uniqueness and point-lookup are already free.
 */
@Component
public class V004CreateCommerceIndexes implements Migration {

  @Override
  public String id() {
    return "V004__create_commerce_indexes";
  }

  @Override
  public String description() {
    return "orders (user_id, status) + unique sparse mor_order_id; unique webhook_events.provider_event_id; "
        + "unique idempotency_keys (user_id, endpoint, key) + TTL";
  }

  @Override
  public void apply(MongoTemplate mongo) {
    // orders: "list my orders, optionally filtered by status" (§4, order history / polling).
    mongo.getCollection("orders")
        .createIndex(Indexes.ascending("user_id", "status"), new IndexOptions().name("orders_user_id_status_idx"));

    // mor_order_id: NULL at creation, set write-once on the first webhook (B2). sparse() means
    // documents where the field is absent are excluded from the index entirely, so many pending
    // orders can coexist without colliding on a shared "null" key.
    mongo.getCollection("orders")
        .createIndex(
            Indexes.ascending("mor_order_id"),
            new IndexOptions().name("orders_mor_order_id_unique_sparse").unique(true).sparse(true));

    // webhook_events: THE dedupe mechanism (see class Javadoc). provider_event_id is a field
    // here, not _id (the collection's _id is an app-generated UUIDv7 like every other write
    // path), so it needs its own explicit unique index.
    mongo.getCollection("webhook_events")
        .createIndex(
            Indexes.ascending("provider_event_id"),
            new IndexOptions().name("webhook_events_provider_event_id_unique").unique(true));
    // Reverse lookup: "which webhook deliveries correspond to this order" (support/debugging).
    mongo.getCollection("webhook_events")
        .createIndex(Indexes.ascending("order_id"), new IndexOptions().name("webhook_events_order_id_idx"));

    // idempotency_keys: Postgres PK is (user_id, endpoint, key) - reproduce as a compound unique
    // index since _id here is not that composite. Plus a ~24h TTL (Appendix A) so retried-request
    // caches don't grow unbounded.
    mongo.getCollection("idempotency_keys")
        .createIndex(
            Indexes.ascending("user_id", "endpoint", "key"),
            new IndexOptions().name("idempotency_keys_user_endpoint_key_unique").unique(true));
    mongo.getCollection("idempotency_keys")
        .createIndex(
            Indexes.ascending("expires_at"),
            new IndexOptions().name("idempotency_keys_expires_at_ttl").expireAfter(0L, TimeUnit.SECONDS));
  }
}
