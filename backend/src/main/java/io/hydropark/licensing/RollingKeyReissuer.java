package io.hydropark.licensing;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.hydropark.common.Uuid7;
import java.time.Instant;
import java.util.Base64;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.core.query.Update;
import org.springframework.stereotype.Component;

/**
 * No-stranding on key roll-off (BACKEND-DESIGN §6.3 B7, §6.4). A device that auto-updates to a build
 * whose trusted set has <em>dropped</em> key {@code a} would be stranded if its cached license were
 * still signed by {@code a}. To prevent it, the server <b>proactively re-issues</b> active licenses
 * signed under a key nearing roll-off, under the current active key, marking the old row
 * {@code superseded}. A key's removal from shipped builds is then <b>gated on coverage</b> -
 * {@link #coverageForKid} reports the remaining exposure.
 *
 * <p>Re-issue is <b>additive</b>: it never invalidates a still-cached token (§6.3), it only mints a
 * fresh one under a still-trusted key so the old can be safely dropped. Gated on
 * {@code hydropark.issuer.enabled=true} because it signs.
 */
@Component
@ConditionalOnProperty(name = "hydropark.issuer.enabled", havingValue = "true")
public class RollingKeyReissuer {

  private static final Logger log = LoggerFactory.getLogger(RollingKeyReissuer.class);
  private static final Base64.Decoder B64URL = Base64.getUrlDecoder();

  /** Coverage snapshot for the removal gate: 0 remaining ⇒ safe to drop the key from builds. */
  public record KeyCoverage(String kid, long remainingActiveLicenses, boolean safeToRemove) {}

  private final TrustedKeySet keys;
  private final LicenseSigner signer;
  private final LicenseRepository licenses;
  private final LicenseAuditRepository audits;
  private final MongoTemplate mongo;
  private final ObjectMapper jsonMapper = new ObjectMapper();

  public RollingKeyReissuer(
      TrustedKeySet keys,
      LicenseSigner signer,
      LicenseRepository licenses,
      LicenseAuditRepository audits,
      MongoTemplate mongo) {
    this.keys = keys;
    this.signer = signer;
    this.licenses = licenses;
    this.audits = audits;
    this.mongo = mongo;
  }

  /**
   * Re-issues every active license whose signing key is nearing roll-off - the oldest still-trusted
   * kid, plus any kid that has already rolled off the window but still has live licenses. Returns the
   * number re-issued.
   */
  public int reissueForRollingKey() {
    String activeKid = keys.active().kid();
    Set<String> targets = kidsNearingRollOff(activeKid);
    if (targets.isEmpty()) {
      return 0;
    }

    int reissued = 0;
    for (String kid : targets) {
      for (License old : licenses.findByStatusAndSigningKeyId("active", kid)) {
        reissueOne(old);
        reissued++;
      }
    }
    log.info("rolling-key re-issue: {} licenses moved onto kid={}", reissued, activeKid);
    return reissued;
  }

  /**
   * The kids we consider "nearing roll-off": the oldest kid still in the shipped window (the next to
   * fall out on the following rotation), and any kid no longer in the window that still has active
   * licenses (already rolled off - re-issue is the only way to un-strand those before their build
   * updates).
   */
  Set<String> kidsNearingRollOff(String activeKid) {
    Set<String> targets = new LinkedHashSet<>();
    keys.oldestKid().filter(kid -> !kid.equals(activeKid)).ifPresent(targets::add);

    Set<String> trusted = keys.kids();
    for (License l : licenses.findByStatus("active")) {
      if (!trusted.contains(l.getSigningKeyId())) {
        targets.add(l.getSigningKeyId());
      }
    }
    return targets;
  }

  /** How safe is it to drop {@code kid} from shipped builds right now (§6.3 coverage gate). */
  public KeyCoverage coverageForKid(String kid) {
    long remaining = licenses.countByStatusAndSigningKeyId("active", kid);
    return new KeyCoverage(kid, remaining, remaining == 0);
  }

  /**
   * Supersede the old row and mint a fresh token under the active key. Ordering is crash-safe
   * without a transaction: we supersede <em>first</em> (freeing the {@code WHERE active}
   * partial-unique slot), then insert the replacement. A crash in between leaves no active row for
   * that {@code (user, skill, device)} - which the device simply re-mints on its next online launch,
   * while its cached token stays valid offline under its old (still-trusted) kid. Re-issue is
   * additive, so this never strands anyone.
   */
  void reissueOne(License old) {
    LicensePayload prior = decodeStored(old.getToken());

    // A fresh identity + issue time under the newest key; bindings are preserved verbatim.
    LicensePayload next =
        new LicensePayload(
            Uuid7.prefixed("lic"),
            prior.sub(),
            prior.skillId(),
            prior.versionConstraint(),
            prior.entitlement(),
            prior.deviceId(),
            prior.deviceBinding(),
            prior.maxDevices(),
            Instant.now().getEpochSecond(),
            null,
            prior.iss());
    LicenseSigner.Signed signed = signer.signPayload(next);

    // Supersede first so the (user, skill, device) WHERE active partial-unique index has room.
    mongo.updateFirst(
        Query.query(Criteria.where("_id").is(old.getId()).and("status").is("active")),
        new Update().set("status", "superseded"),
        License.class);

    licenses.insert(
        License.active(
            next.licenseId(),
            next.sub(),
            next.skillId(),
            next.deviceId(),
            signed.kid(),
            signed.token(),
            Instant.now()));

    audits.save(
        LicenseAudit.of(
            Uuid7.generate(),
            next.licenseId(),
            signed.kid(),
            IssuanceRateLimiter.CALLER_REISSUE,
            next.sub(),
            next.skillId(),
            next.deviceId(),
            Instant.now()));
  }

  /**
   * Decode the payload of a token we ourselves stored - no signature check needed, it is our own
   * audit copy and may be signed under a kid that has already left the trusted set (exactly the case
   * re-issue exists to rescue).
   */
  private LicensePayload decodeStored(String token) {
    try {
      String[] parts = token.split("\\.", -1);
      JsonNode p = jsonMapper.readTree(B64URL.decode(parts[1]));
      return new LicensePayload(
          text(p, "license_id"),
          text(p, "sub"),
          text(p, "skill_id"),
          text(p, "version_constraint"),
          text(p, "entitlement"),
          text(p, "device_id"),
          text(p, "device_binding"),
          p.path("max_devices").asInt(0),
          p.path("iat").asLong(0),
          null,
          text(p, "iss"));
    } catch (Exception e) {
      throw new IllegalStateException("stored license token is unparseable: " + token, e);
    }
  }

  private static String text(JsonNode node, String field) {
    JsonNode v = node.get(field);
    return v == null || v.isNull() ? null : v.asText();
  }

  List<License> activeLicensesUnderKid(String kid) {
    return licenses.findByStatusAndSigningKeyId("active", kid);
  }
}
