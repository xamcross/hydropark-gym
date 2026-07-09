package io.hydropark.migration.changesets;

import com.mongodb.client.model.Filters;
import com.mongodb.client.model.IndexOptions;
import com.mongodb.client.model.Indexes;
import io.hydropark.migration.Migration;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.stereotype.Component;

/**
 * Indexes for the device registry (BACKEND-DESIGN §3.4): {@code devices}.
 *
 * <p>Also covers {@code device_slot_counters} by explicit decision to add NO index: per §11.1's
 * mechanism mapping, the 5-active-slot cap is enforced not by a partial index (§3.4: "a partial
 * index does NOT cap a count") but by an atomic per-user counter document, {@code
 * findOneAndUpdate({_id: user, activeSlots: {$lt: 5}}, {$inc: {activeSlots: 1}})}. That access
 * pattern is a point lookup/update by {@code _id} (= {@code user_id}), which the default {@code
 * _id} index already serves - a secondary index would add write cost for zero read benefit. This
 * migration exists (rather than being silently skipped) so the omission is a recorded decision,
 * not an oversight.
 */
@Component
public class V006CreateDeviceIndexes implements Migration {

  @Override
  public String id() {
    return "V006__create_device_indexes";
  }

  @Override
  public String description() {
    return "devices unique (user_id, fingerprint) + partial active-slot index by user_id "
        + "(device_slot_counters intentionally gets no secondary index - see class Javadoc)";
  }

  @Override
  public void apply(MongoTemplate mongo) {
    // Match-or-create on (user_id, fingerprint): a reinstall/OS-move reclaims its existing slot
    // instead of consuming a new one (B4/§13.5).
    mongo.getCollection("devices")
        .createIndex(
            Indexes.ascending("user_id", "fingerprint"),
            new IndexOptions().name("devices_user_fingerprint_unique").unique(true));

    // "List this user's active devices" (GET /devices, and the slot-count fallback path) -
    // partial on status=active so deauthorized devices don't bloat the index.
    mongo.getCollection("devices")
        .createIndex(
            Indexes.ascending("user_id"),
            new IndexOptions()
                .name("devices_user_active_idx")
                .partialFilterExpression(Filters.eq("status", "active")));

    // device_slot_counters: intentionally no index beyond the default _id index. See class
    // Javadoc.
  }
}
