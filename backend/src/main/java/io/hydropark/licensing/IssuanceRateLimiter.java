package io.hydropark.licensing;

import io.hydropark.common.ApiException;
import io.hydropark.common.ErrorCode;
import io.hydropark.config.AppProperties;
import java.time.Instant;
import java.util.Map;
import java.util.Set;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.stereotype.Component;

/**
 * Issuance rate limiting (BACKEND-DESIGN §6.2 N12). The <b>per-{@code sub} limit is the primary
 * control</b>; the global per-minute limit is only a <b>wide backstop</b>, so one abuser can't
 * exhaust a shared budget and delay everyone else's post-purchase unlock.
 *
 * <p>Counts are derived from the append-only {@code license_audit} log itself, which makes the limit
 * correct across issuer instances without any shared in-memory state - the same log we must write
 * anyway is the counter. Maintenance re-signs ({@code caller='reissue-rolling-key'}) are excluded
 * from the per-user count so background key rotation never throttles a real user.
 *
 * <p><b>Whitelisted callers (P1-23.1).</b> The anti-abuse limits exist to catch a signing
 * <em>oracle</em> being probed one token at a time - not authorized server-side maintenance. Two
 * callers are therefore exempt from the throttle: the rolling-key re-issuer ({@link #CALLER_REISSUE})
 * and the dual-control continuity batch pre-mint ({@link #CALLER_BATCH_PREMINT}). Both still write an
 * audit row for every sign, so the log stays complete; they are simply not <em>counted</em> as user
 * demand. The exemption is a rate-limit whitelist only - it does <b>not</b> relax the Issuer's
 * settled-grant authorization keystone, which runs unconditionally on every mint regardless of caller.
 */
@Component
public class IssuanceRateLimiter {

  static final String CALLER_ISSUE = "licenses.issue";
  static final String CALLER_REISSUE = "reissue-rolling-key";

  /**
   * The dual-control continuity batch pre-mint (P1-23.1). Public because the {@code continuity}
   * package tags its mints with it so this limiter recognises and exempts them - the string lives in
   * exactly one place so the whitelist and the audit label can never drift apart.
   */
  public static final String CALLER_BATCH_PREMINT = "continuity.batch-premint";

  /**
   * Callers exempt from the throttle: authorized server-side maintenance, not oracle probing. They
   * are excluded from the per-user count (which already keys on {@link #CALLER_ISSUE}) <em>and</em>
   * from the global backstop, so a large batch can neither throttle itself nor delay real users'
   * post-purchase unlocks.
   */
  private static final Set<String> RATE_LIMIT_EXEMPT_CALLERS =
      Set.of(CALLER_REISSUE, CALLER_BATCH_PREMINT);

  private final MongoTemplate mongo;
  private final int maxPerUserPerHour;
  private final int maxGlobalPerMinute;

  public IssuanceRateLimiter(MongoTemplate mongo, AppProperties props) {
    this.mongo = mongo;
    this.maxPerUserPerHour = props.getLicensing().getMaxIssuancesPerUserPerHour();
    this.maxGlobalPerMinute = props.getLicensing().getMaxIssuancesGlobalPerMinute();
  }

  /** Throws {@code RATE_LIMITED} (429) when either window is exhausted. */
  public void check(String sub) {
    check(sub, CALLER_ISSUE);
  }

  /**
   * Caller-aware form. A {@linkplain #RATE_LIMIT_EXEMPT_CALLERS whitelisted} caller (maintenance
   * re-issue, continuity batch pre-mint) returns immediately - it is authorized issuance, never
   * oracle abuse. Every other caller is throttled exactly as before.
   */
  public void check(String sub, String caller) {
    if (RATE_LIMIT_EXEMPT_CALLERS.contains(caller)) {
      return;
    }

    Instant now = Instant.now();

    // Primary control: per-identity.
    long perUser =
        mongo.count(
            Query.query(
                Criteria.where("sub")
                    .is(sub)
                    .and("caller")
                    .is(CALLER_ISSUE)
                    .and("at")
                    .gte(now.minusSeconds(3600))),
            LicenseAudit.class);
    if (perUser >= maxPerUserPerHour) {
      throw new ApiException(
          ErrorCode.RATE_LIMITED,
          "issuance limit reached for this account; try again later",
          Map.of("scope", "per_user", "window", "1h"));
    }

    // Wide backstop: global signer load. Whitelisted maintenance/batch signs are excluded so a
    // background job can never consume the backstop budget meant to protect real users.
    long global =
        mongo.count(
            Query.query(
                Criteria.where("at")
                    .gte(now.minusSeconds(60))
                    .and("caller")
                    .nin(RATE_LIMIT_EXEMPT_CALLERS)),
            LicenseAudit.class);
    if (global >= maxGlobalPerMinute) {
      throw new ApiException(
          ErrorCode.RATE_LIMITED,
          "issuer is briefly saturated; retry shortly",
          Map.of("scope", "global", "window", "1m"));
    }
  }
}
