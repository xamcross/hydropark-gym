package io.hydropark.devices;

import io.hydropark.common.ApiException;
import io.hydropark.common.ErrorCode;
import io.hydropark.config.AppProperties;
import io.hydropark.port.Ports;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.stereotype.Component;

/**
 * {@code devices}' implementation of {@link Ports.DeviceSlotPort} (BE §3.4). Consumed by {@code
 * licensing}: the Issuer calls {@link #assertActiveSlot} before minting a per-device license and
 * {@link #fingerprintOf} to embed the coarse fingerprint as the license {@code device_binding}.
 */
@Component
public class DeviceSlotPortImpl implements Ports.DeviceSlotPort {

  private final MongoTemplate mongo;
  private final DeviceRepository devices;
  private final int maxActiveSlots;

  public DeviceSlotPortImpl(MongoTemplate mongo, DeviceRepository devices, AppProperties props) {
    this.mongo = mongo;
    this.devices = devices;
    this.maxActiveSlots = props.getDevices().getMaxActiveSlots();
  }

  /**
   * Confirms the device can mint a license: it exists, belongs to the caller, and is an active slot
   * within the cap.
   *
   * <ul>
   *   <li>{@code NOT_FOUND} - unknown id, or a deauthorized device (it is not an active slot).
   *   <li>{@code FORBIDDEN} - the device belongs to another user.
   *   <li>{@code SLOT_LIMIT_REACHED} - defensive: the user's active count exceeds the cap (counter
   *       drift that {@link DeviceSlotReconciler} has not yet repaired). Should never fire in
   *       steady state.
   * </ul>
   */
  @Override
  public void assertActiveSlot(String userId, String deviceId) {
    Device device = devices.findById(deviceId).orElseThrow(() -> ApiException.notFound("device"));
    if (!device.getUserId().equals(userId)) {
      throw new ApiException(ErrorCode.FORBIDDEN, "device belongs to another user");
    }
    if (!device.isActive()) {
      throw new ApiException(ErrorCode.NOT_FOUND, "device is not an active slot");
    }
    long activeCount =
        mongo.count(
            Query.query(Criteria.where("userId").is(userId).and("status").is(Device.ACTIVE)),
            Device.class);
    if (activeCount > maxActiveSlots) {
      throw new ApiException(
          ErrorCode.SLOT_LIMIT_REACHED, "active device slots exceed the per-user cap");
    }
  }

  /**
   * The coarse, server-side-only fingerprint the Issuer embeds as {@code device_binding} (§3.4,
   * §6.1). Never re-derived offline - it exists solely so a leaked license names the slot it was
   * minted for.
   */
  @Override
  public String fingerprintOf(String deviceId) {
    Device device = devices.findById(deviceId).orElseThrow(() -> ApiException.notFound("device"));
    return device.getFingerprint();
  }
}
