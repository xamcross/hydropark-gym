package io.hydropark.licensing;

import io.hydropark.licensing.RollingKeyReissuer.KeyCoverage;
import java.util.ArrayList;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Drives the no-stranding key rotation on a schedule (BACKEND-DESIGN §6.3 B7, BACKLOG P1-16.6b). It
 * proactively re-issues active licenses whose signing key is nearing roll-off, under the current
 * active key, so a client that auto-updates to a build that has <em>dropped</em> that key is never
 * stranded with a cached token it can no longer verify. See {@link RollingKeyReissuer} for the
 * mechanism; this class is only the trigger + the coverage telemetry.
 *
 * <p><b>Two zone gates, both required.</b> The bean exists only where {@code
 * hydropark.issuer.enabled=true} (it signs, so it belongs to the isolated key-holding zone) <b>and</b>
 * {@code hydropark.licensing.reissue.enabled=true}. The second flag defaults to <em>false</em>
 * ({@code matchIfMissing} is left at its default, so an absent property does not match), so wiring
 * this scheduler never surprises an existing deployment: re-issue starts only when an operator turns
 * it on. {@link LicensingSchedulingConfig} supplies the {@code @EnableScheduling} the issuer zone
 * needs.
 *
 * <p><b>Why no {@code @Transactional} here.</b> A {@code @Scheduled} method that is <em>also</em>
 * {@code @Transactional} is a trap: the Spring proxy that applies {@code @Transactional} is only
 * engaged on an <em>external</em> call, and the scheduler invokes the annotated method in a way that
 * does not reliably route a fresh transaction around each re-sign - a single outer transaction would
 * in any case be wrong here, because it would wrap thousands of independent re-issues into one
 * all-or-nothing unit and hold locks for the whole run. Instead each re-issue relies on
 * {@link RollingKeyReissuer#reissueOne}'s crash-safe <b>supersede-then-insert</b> ordering: the old
 * row is marked {@code superseded} first (freeing the {@code WHERE active} partial-unique slot), then
 * the replacement is inserted. A crash between the two simply leaves that {@code (user, skill,
 * device)} with no active row, which the device re-mints on its next online launch while its cached
 * token stays valid offline under the still-trusted old {@code kid}. Re-issue is additive, so this
 * ordering needs no outer transaction and tolerates a partial run.
 */
@Component
@ConditionalOnProperty(
    name = {"hydropark.issuer.enabled", "hydropark.licensing.reissue.enabled"},
    havingValue = "true")
public class RollingKeyReissuanceJob {

  private static final Logger log = LoggerFactory.getLogger(RollingKeyReissuanceJob.class);

  private final RollingKeyReissuer reissuer;
  private final TrustedKeySet keys;

  public RollingKeyReissuanceJob(RollingKeyReissuer reissuer, TrustedKeySet keys) {
    this.reissuer = reissuer;
    this.keys = keys;
  }

  /**
   * One re-issue sweep. Runs proactively so a key's licenses are moved onto the current key
   * <em>before</em> the key rolls out of the shipped K-window. A failing tick is logged and
   * swallowed so it never kills the scheduler.
   */
  @Scheduled(
      initialDelayString = "${hydropark.licensing.reissue.interval-ms:3600000}",
      fixedDelayString = "${hydropark.licensing.reissue.interval-ms:3600000}")
  public void sweep() {
    try {
      int reissued = reissuer.reissueForRollingKey();
      List<KeyCoverage> coverage = coverageForRollOffCandidates();
      log.info(
          "rolling-key re-issue sweep: reissued={} activeKid={} rollOffCoverage={}",
          reissued,
          keys.oldestKid().orElse("<none>"),
          coverage);
      for (KeyCoverage c : coverage) {
        if (!c.safeToRemove()) {
          log.warn(
              "kid {} still cited by {} active license(s) - NOT safe to drop from shipped builds",
              c.kid(),
              c.remainingActiveLicenses());
        }
      }
    } catch (RuntimeException e) {
      // Never let one sweep kill the scheduler; the next tick retries.
      log.error("rolling-key re-issue sweep failed", e);
    }
  }

  /**
   * The removal gate for a single {@code kid}, actuator-free so ops (or a release pipeline) can query
   * it without exposing the signer's internals over HTTP. {@code safeToRemove()==false} means a live
   * population still depends on the key and a build that drops it would strand them (§6.3).
   */
  public KeyCoverage coverageForKid(String kid) {
    return reissuer.coverageForKid(kid);
  }

  /**
   * Coverage for exactly the kids a rotation is about to strand: the oldest kid still in the shipped
   * window (next to fall out) and any kid already outside the window that still has active licenses.
   * After a successful sweep these should all report {@code safeToRemove()}; anything that does not is
   * the residual a build must not drop yet.
   */
  public List<KeyCoverage> coverageForRollOffCandidates() {
    List<KeyCoverage> out = new ArrayList<>();
    for (String kid : reissuer.kidsNearingRollOff(keys.active().kid())) {
      out.add(reissuer.coverageForKid(kid));
    }
    return out;
  }
}
