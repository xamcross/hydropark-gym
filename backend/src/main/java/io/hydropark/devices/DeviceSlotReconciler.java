package io.hydropark.devices;

import java.time.Instant;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.core.query.Update;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Defensive repair for the per-user slot counter (BE §11.1). The counter is a <b>cache</b> of a fact
 * the {@code devices} collection owns: the true active-slot count is {@code count(devices where
 * user_id = u and status = active)}. A crash between a slot claim/release and the device write, or a
 * lost update, could leave the cache off by one - which would either wrongly reject a legitimate 6th
 * registration or wrongly admit one.
 *
 * <p>This job recomputes the authoritative count from the collection and corrects any drift, so the
 * counter is self-healing rather than permanently wrong. Scheduling is enabled by {@link
 * DevicesConfig}; the interval is overridable via {@code hydropark.devices.slot-reconcile-ms}
 * (default 15 min).
 */
@Component
public class DeviceSlotReconciler {

  private static final Logger log = LoggerFactory.getLogger(DeviceSlotReconciler.class);

  private final MongoTemplate mongo;

  public DeviceSlotReconciler(MongoTemplate mongo) {
    this.mongo = mongo;
  }

  @Scheduled(
      initialDelayString = "${hydropark.devices.slot-reconcile-ms:900000}",
      fixedDelayString = "${hydropark.devices.slot-reconcile-ms:900000}")
  public void reconcile() {
    List<DeviceSlotCounter> all = mongo.findAll(DeviceSlotCounter.class);
    int corrected = 0;
    for (DeviceSlotCounter counter : all) {
      String userId = counter.getId();
      long actual =
          mongo.count(
              Query.query(Criteria.where("userId").is(userId).and("status").is(Device.ACTIVE)),
              Device.class);
      if (actual != counter.getActiveSlots()) {
        log.warn(
            "device slot counter drift for user {}: counter={}, actual={} - repairing",
            userId,
            counter.getActiveSlots(),
            actual);
        mongo.updateFirst(
            Query.query(Criteria.where("id").is(userId)),
            new Update().set("activeSlots", (int) actual).set("updatedAt", Instant.now()),
            DeviceSlotCounter.class);
        corrected++;
      }
    }
    if (corrected > 0) {
      log.info("device slot reconciler corrected {} counter(s)", corrected);
    }
  }
}
