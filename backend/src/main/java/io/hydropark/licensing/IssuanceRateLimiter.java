package io.hydropark.licensing;

import io.hydropark.common.ApiException;
import io.hydropark.common.ErrorCode;
import io.hydropark.config.AppProperties;
import java.time.Instant;
import java.util.Map;
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
 */
@Component
public class IssuanceRateLimiter {

  static final String CALLER_ISSUE = "licenses.issue";
  static final String CALLER_REISSUE = "reissue-rolling-key";

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

    // Wide backstop: global signer load.
    long global =
        mongo.count(
            Query.query(Criteria.where("at").gte(now.minusSeconds(60))), LicenseAudit.class);
    if (global >= maxGlobalPerMinute) {
      throw new ApiException(
          ErrorCode.RATE_LIMITED,
          "issuer is briefly saturated; retry shortly",
          Map.of("scope", "global", "window", "1m"));
    }
  }
}
