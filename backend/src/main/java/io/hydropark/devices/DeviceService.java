package io.hydropark.devices;

import io.hydropark.common.ApiException;
import io.hydropark.common.CursorPage;
import io.hydropark.common.ErrorCode;
import io.hydropark.common.Uuid7;
import io.hydropark.config.AppProperties;
import io.hydropark.port.Ports;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.data.domain.Sort;
import org.springframework.data.mongodb.core.FindAndModifyOptions;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.core.query.Update;
import org.springframework.stereotype.Service;

/**
 * BACKLOG P1-17 (BE §3.4, §4.6). Owns registration, listing, rename and deauthorization of device
 * slots, and the 5-slot cap.
 *
 * <p><b>Match-or-create is the load-bearing behaviour.</b> A reinstall or OS move presents the same
 * coarse fingerprint and must <em>reclaim</em> its existing slot rather than burn a new one (B4). So
 * a slot is consumed only by a genuinely new fingerprint or by re-activating a previously
 * deauthorized device - never by re-registering an already-active one. Getting this ordering wrong
 * leaks slots on every reinstall.
 */
@Service
public class DeviceService {

  private final MongoTemplate mongo;
  private final DeviceRepository devices;
  private final DeviceSlotCounters counters;
  private final RotationVelocityDetector velocity;
  private final Ports.StepUpPort stepUp;
  private final int maxActiveSlots;

  public DeviceService(
      MongoTemplate mongo,
      DeviceRepository devices,
      DeviceSlotCounters counters,
      RotationVelocityDetector velocity,
      Ports.StepUpPort stepUp,
      AppProperties props) {
    this.mongo = mongo;
    this.devices = devices;
    this.counters = counters;
    this.velocity = velocity;
    this.stepUp = stepUp;
    this.maxActiveSlots = props.getDevices().getMaxActiveSlots();
  }

  // ---------------------------------------------------------------------------------------------
  // POST /v1/devices/register  (step-up gated - BE §4.6/§8 SF11)
  // ---------------------------------------------------------------------------------------------

  /**
   * Match-or-create on {@code (user_id, fingerprint)}. Step-up gated: minting a device slot is a
   * perpetual effect a 15-minute access token alone must not authorize (SF11).
   *
   * @param stepUpToken the {@code X-Step-Up-Token} header, may be null (then step-up fails closed)
   */
  public Device register(String userId, String name, String fingerprint, String stepUpToken) {
    if (fingerprint == null || fingerprint.isBlank()) {
      throw ApiException.validation("fingerprint is required");
    }
    stepUp.assertStepUp(userId, stepUpToken, Ports.StepUpActions.DEVICE_REGISTER);

    counters.ensure(userId);
    Instant now = Instant.now();
    String cleanName = (name == null || name.isBlank()) ? null : name.trim();

    Device existing = devices.findByUserIdAndFingerprint(userId, fingerprint).orElse(null);
    if (existing != null) {
      return existing.isActive()
          ? reclaimActive(existing, cleanName, now)
          : reactivate(existing, cleanName, now, userId);
    }
    return createNew(userId, cleanName, fingerprint, now);
  }

  /**
   * The reinstall path: the fingerprint already maps to an <b>active</b> slot. Do NOT touch the
   * counter - the slot is already held. Just refresh {@code last_seen_at} (and name if supplied).
   */
  private Device reclaimActive(Device existing, String name, Instant now) {
    Update u = new Update().set("lastSeenAt", now);
    if (name != null) {
      u.set("name", name);
    }
    return applyReturningNew(existing.getId(), null, u);
  }

  /**
   * A previously deauthorized device coming back consumes a slot - so it must pass the cap - and is
   * counted as rotation churn (the reauthorize half of the velocity signal).
   */
  private Device reactivate(Device existing, String name, Instant now, String userId) {
    if (counters.tryClaim(userId, maxActiveSlots) == null) {
      throw slotLimitReached();
    }
    Update u = new Update().set("status", Device.ACTIVE).set("lastSeenAt", now);
    if (name != null) {
      u.set("name", name);
    }
    // Guard the flip on status=deauthorized so a concurrent reactivation can't double-claim.
    Device updated = applyReturningNew(existing.getId(), Device.DEAUTHORIZED, u);
    if (updated == null) {
      // Someone reactivated it first; give our claim back so the counter doesn't leak.
      counters.release(userId);
      return devices.findById(existing.getId()).orElse(existing);
    }
    velocity.record(userId, RotationVelocityDetector.REACTIVATE);
    return updated;
  }

  /** A genuinely new fingerprint: claim a slot, then insert. */
  private Device createNew(String userId, String name, String fingerprint, Instant now) {
    if (counters.tryClaim(userId, maxActiveSlots) == null) {
      throw slotLimitReached();
    }
    Device device =
        new Device(
            Uuid7.generate(),
            userId,
            name == null ? Device.DEFAULT_NAME : name,
            fingerprint,
            Device.ACTIVE,
            now,
            now);
    try {
      devices.insert(device);
    } catch (DuplicateKeyException race) {
      // Two concurrent "new device, same fingerprint" calls both saw no row and both claimed a
      // slot; the unique (user_id, fingerprint) index let only one insert win. Release the loser's
      // claim and fold into a reclaim so the counter stays exact.
      counters.release(userId);
      Device winner =
          devices
              .findByUserIdAndFingerprint(userId, fingerprint)
              .orElseThrow(() -> new ApiException(ErrorCode.CONFLICT, "device register race"));
      return winner.isActive()
          ? reclaimActive(winner, name, now)
          : reactivate(winner, name, now, userId);
    }
    counters.incLifetime(userId);
    velocity.record(userId, RotationVelocityDetector.NEW_DEVICE);
    return device;
  }

  // ---------------------------------------------------------------------------------------------
  // GET /v1/devices  (cursor-paginated)
  // ---------------------------------------------------------------------------------------------

  public CursorPage<Device> list(String userId, Integer limit, String cursor) {
    int lim = CursorPage.clampLimit(limit);
    String after = CursorPage.decode(cursor);

    Query q = Query.query(Criteria.where("userId").is(userId));
    if (after != null) {
      q.addCriteria(Criteria.where("id").gt(after));
    }
    // UUIDv7 ids sort by creation time, so id order is a stable, opaque cursor.
    q.with(Sort.by(Sort.Direction.ASC, "id")).limit(lim + 1);
    List<Device> rows = mongo.find(q, Device.class);
    return CursorPage.from(rows, lim, Device::getId);
  }

  // ---------------------------------------------------------------------------------------------
  // PATCH /v1/devices/{id}  (rename)
  // ---------------------------------------------------------------------------------------------

  public Device rename(String userId, String deviceId, String name) {
    if (name == null || name.isBlank()) {
      throw ApiException.validation("name is required");
    }
    Device device = requireOwned(userId, deviceId);
    return applyReturningNew(device.getId(), null, new Update().set("name", name.trim()));
  }

  // ---------------------------------------------------------------------------------------------
  // POST /v1/devices/{id}/deauthorize
  //   (+ step-up when deauthorizing the LAST active device - the trust-root reset path, Q4)
  // ---------------------------------------------------------------------------------------------

  public Device deauthorize(String userId, String deviceId, String stepUpToken) {
    Device device = requireOwned(userId, deviceId);
    if (!device.isActive()) {
      return device; // idempotent - already deauthorized.
    }

    long activeCount =
        mongo.count(
            Query.query(Criteria.where("userId").is(userId).and("status").is(Device.ACTIVE)),
            Device.class);
    if (activeCount <= 1) {
      // Deauthorizing the last active device empties the account's trust root; a stolen 15-minute
      // token must not be able to do this and then TOFU a rogue replacement device (BE §4.6 Q4/§8).
      stepUp.assertStepUp(userId, stepUpToken, Ports.StepUpActions.DEVICE_DEAUTHORIZE_LAST);
    }

    // Flip guarded on status=active so the slot is released exactly once even under concurrency.
    Device updated =
        applyReturningNew(deviceId, Device.ACTIVE, new Update().set("status", Device.DEAUTHORIZED));
    if (updated == null) {
      return devices.findById(deviceId).orElse(device); // lost the race; already deauthorized.
    }
    counters.release(userId);
    velocity.record(userId, RotationVelocityDetector.DEAUTHORIZE);
    return updated;
  }

  // ---------------------------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------------------------

  private Device requireOwned(String userId, String deviceId) {
    Device device = devices.findById(deviceId).orElseThrow(() -> ApiException.notFound("device"));
    if (!device.getUserId().equals(userId)) {
      // Do not leak existence of another user's device beyond the generic forbidden.
      throw new ApiException(ErrorCode.FORBIDDEN, "device belongs to another user");
    }
    return device;
  }

  /**
   * Apply {@code update} to a device, optionally guarded on a required current status, returning the
   * post-update document (or null if the guard did not match).
   */
  private Device applyReturningNew(String deviceId, String requiredStatus, Update update) {
    Criteria c = Criteria.where("id").is(deviceId);
    if (requiredStatus != null) {
      c = c.and("status").is(requiredStatus);
    }
    return mongo.findAndModify(
        Query.query(c), update, FindAndModifyOptions.options().returnNew(true), Device.class);
  }

  private static ApiException slotLimitReached() {
    return new ApiException(
        ErrorCode.SLOT_LIMIT_REACHED,
        "5 active device slots already in use; deauthorize one to add a device",
        Map.of("max_active_slots", 5));
  }
}
