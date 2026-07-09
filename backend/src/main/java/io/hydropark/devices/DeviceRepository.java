package io.hydropark.devices;

import java.util.Optional;
import org.springframework.data.mongodb.repository.MongoRepository;

/**
 * Point lookups only. List/cursor queries and every atomic slot mutation go through {@link
 * DeviceService}'s and {@link DeviceSlotCounters}' {@code MongoTemplate} use, because the slot cap
 * and the match-or-create reclaim need conditional {@code findAndModify}, not derived finders.
 */
public interface DeviceRepository extends MongoRepository<Device, String> {

  /** Match-or-create key (BE §3.4): the unique {@code (user_id, fingerprint)} index backs this. */
  Optional<Device> findByUserIdAndFingerprint(String userId, String fingerprint);
}
