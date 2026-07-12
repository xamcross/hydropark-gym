package io.hydropark.devices;

import java.util.List;
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

  /**
   * A user's slots in a given status - the P1-23.1 continuity batch enumerates {@code active} devices
   * to pre-mint one license per (owned skill x device). Read-only; slot-cap mutations still go through
   * {@link DeviceSlotCounters}' conditional {@code findAndModify}.
   */
  List<Device> findByUserIdAndStatus(String userId, String status);
}
