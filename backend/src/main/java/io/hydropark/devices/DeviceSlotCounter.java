package io.hydropark.devices;

import java.time.Instant;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

/**
 * Per-user active-slot counter (BE §11.1). Mongo has <b>no advisory locks</b>, so the 5-slot cap
 * from BE §3.4 cannot be a {@code pg_advisory_xact_lock} and cannot be a partial index (an index
 * caps uniqueness, not a <em>count</em>). Instead a slot is claimed with a single conditional
 * update:
 *
 * <pre>{@code
 * findOneAndUpdate({_id: userId, activeSlots: {$lt: 5}}, {$inc: {activeSlots: 1}})
 * }</pre>
 *
 * <p>A null result means the cap is reached -> {@code SLOT_LIMIT_REACHED}. Release decrements. The
 * counter is a <b>cache of a fact the {@code devices} collection owns</b> (count of active rows);
 * {@link DeviceSlotReconciler} repairs any drift on a schedule, so a leaked/lost increment is
 * self-healing rather than permanent.
 *
 * <p>{@code _id} is the {@code user_id}. The document also carries the anti-abuse signals of BE §3.4
 * SF7: the generous lifetime device budget and a rolling rotation-velocity window. Those only ever
 * <em>flag</em> for soft review - they never hard-block issuance.
 */
@Document(collection = "device_slot_counters")
public class DeviceSlotCounter {

  /** The user id. */
  @Id private String id;

  /** Hard-capped active slots. The only value the 5-slot cap reads. */
  @Field("active_slots")
  private int activeSlots;

  /** Lifetime distinct devices ever created for this user (§3.4 soft budget signal). */
  @Field("lifetime_devices")
  private long lifetimeDevices;

  /** Start of the current rotation-velocity window. */
  @Field("churn_window_start")
  private Instant churnWindowStart;

  /** Slot-churn events (new device / reactivate / deauthorize) within the current window. */
  @Field("churn_count")
  private int churnCount;

  /** Raised when the soft budget or rotation velocity is exceeded; never blocks (§3.4 SF7). */
  @Field("flagged_for_review")
  private boolean flaggedForReview;

  @Field("updated_at")
  private Instant updatedAt;

  public DeviceSlotCounter() {}

  public String getId() {
    return id;
  }

  public void setId(String id) {
    this.id = id;
  }

  public int getActiveSlots() {
    return activeSlots;
  }

  public void setActiveSlots(int activeSlots) {
    this.activeSlots = activeSlots;
  }

  public long getLifetimeDevices() {
    return lifetimeDevices;
  }

  public void setLifetimeDevices(long lifetimeDevices) {
    this.lifetimeDevices = lifetimeDevices;
  }

  public Instant getChurnWindowStart() {
    return churnWindowStart;
  }

  public void setChurnWindowStart(Instant churnWindowStart) {
    this.churnWindowStart = churnWindowStart;
  }

  public int getChurnCount() {
    return churnCount;
  }

  public void setChurnCount(int churnCount) {
    this.churnCount = churnCount;
  }

  public boolean isFlaggedForReview() {
    return flaggedForReview;
  }

  public void setFlaggedForReview(boolean flaggedForReview) {
    this.flaggedForReview = flaggedForReview;
  }

  public Instant getUpdatedAt() {
    return updatedAt;
  }

  public void setUpdatedAt(Instant updatedAt) {
    this.updatedAt = updatedAt;
  }
}
