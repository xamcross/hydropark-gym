package io.hydropark.devices;

import io.hydropark.config.AppProperties;
import java.time.Duration;
import java.time.Instant;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.core.query.Update;
import org.springframework.stereotype.Component;

/**
 * BE §3.4 SF7 - the anti-piracy-at-scale signal. Two things are true and must not be confused:
 *
 * <ul>
 *   <li>The <b>5 active-slot cap</b> is the ONLY hard limit (enforced by {@link DeviceSlotCounters},
 *       not here).
 *   <li>Lifetime distinct devices and rotation <b>velocity</b> are <em>soft</em> signals. Exceeding
 *       either <b>throttles into soft review</b> - it flags the account and emits a metric - but
 *       issuance/registration still succeeds. A legitimate heavy user over years (laptop + desktop +
 *       work machine + fingerprint drift) must never be hard-blocked.
 * </ul>
 *
 * <p>The design names <b>rotation velocity</b> (deauthorize->reauthorize churn, distinct devices per
 * unit time) as the real detector - a hard lifetime count would punish honest users. This is a
 * deliberately simple implementation of that signal: a fixed rolling window of slot-churn events.
 * It is a defensive heuristic, not a correctness guard, so its window bookkeeping is best-effort
 * rather than transactionally exact.
 *
 * <p><b>Scope note:</b> the design frames the lifetime budget as "per (user, skill)", but skill
 * identity is a licensing concern and never reaches the devices package ({@code DeviceSlotPort} has
 * no skill argument). This detector therefore operates at the granularity it owns - per user - and
 * licensing can refine to per-skill at issuance. See the final report.
 */
@Component
public class RotationVelocityDetector {

  private static final Logger log = LoggerFactory.getLogger(RotationVelocityDetector.class);

  /** Rolling window for the velocity signal. */
  static final Duration WINDOW = Duration.ofHours(24);

  /** Churn events per window above which the account is flagged for soft review. */
  static final int VELOCITY_THRESHOLD = 8;

  /** A slot-consuming registration of a brand-new fingerprint. */
  public static final String NEW_DEVICE = "new_device";

  /** Re-activating a previously deauthorized device (the churn half of rotation velocity). */
  public static final String REACTIVATE = "reactivate";

  /** Freeing a slot. */
  public static final String DEAUTHORIZE = "deauthorize";

  private final MongoTemplate mongo;
  private final AppProperties props;

  public RotationVelocityDetector(MongoTemplate mongo, AppProperties props) {
    this.mongo = mongo;
    this.props = props;
  }

  /**
   * Record one slot-lifecycle event and evaluate the soft signals. Never throws for a policy breach
   * - the whole point is that issuance/registration continues while a flag is raised.
   */
  public void record(String userId, String eventKind) {
    try {
      DeviceSlotCounter c = mongo.findById(userId, DeviceSlotCounter.class);
      if (c == null) {
        return; // ensure() runs before any churn event; absence just means nothing to score yet.
      }
      Instant now = Instant.now();
      int windowCount = advanceWindow(userId, c, now);

      boolean flag = false;
      if (windowCount > VELOCITY_THRESHOLD) {
        flag = true;
        log.warn(
            "device rotation velocity tripped soft-review (event={}, user={}, churn={}/{}h) - "
                + "issuance NOT blocked (§3.4 SF7)",
            eventKind,
            userId,
            windowCount,
            WINDOW.toHours());
      }
      int softBudget = props.getDevices().getLifetimeRotationSoftBudget();
      if (c.getLifetimeDevices() > softBudget) {
        flag = true;
        log.warn(
            "lifetime device budget exceeded, throttling to soft-review (user={}, lifetime={}, "
                + "budget={}) - issuance NOT blocked (§3.4 SF7)",
            userId,
            c.getLifetimeDevices(),
            softBudget);
      }
      if (flag && !c.isFlaggedForReview()) {
        mongo.updateFirst(
            Query.query(Criteria.where("id").is(userId)),
            new Update().set("flaggedForReview", true).set("updatedAt", now),
            DeviceSlotCounter.class);
      }
    } catch (RuntimeException e) {
      // A telemetry signal must never break the user-facing operation it is observing.
      log.warn("rotation-velocity evaluation failed for user {} (ignored)", userId, e);
    }
  }

  /**
   * Reset the window if it has elapsed, otherwise increment. Returns the churn count now in the
   * window. Best-effort under concurrency - a lost increment only under-counts a defensive signal.
   */
  private int advanceWindow(String userId, DeviceSlotCounter c, Instant now) {
    Instant start = c.getChurnWindowStart();
    if (start == null || Duration.between(start, now).compareTo(WINDOW) > 0) {
      mongo.updateFirst(
          Query.query(Criteria.where("id").is(userId)),
          new Update().set("churnWindowStart", now).set("churnCount", 1).set("updatedAt", now),
          DeviceSlotCounter.class);
      return 1;
    }
    mongo.updateFirst(
        Query.query(Criteria.where("id").is(userId)),
        new Update().inc("churnCount", 1).set("updatedAt", now),
        DeviceSlotCounter.class);
    return c.getChurnCount() + 1;
  }
}
