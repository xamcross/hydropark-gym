package io.hydropark.licensing;

import io.hydropark.common.ApiException;
import io.hydropark.common.Uuid7;
import io.hydropark.port.Ports.DeviceSlotPort;
import io.hydropark.port.Ports.GrantStatus;
import io.hydropark.port.Ports.IssuedLicense;
import io.hydropark.port.Ports.LicenseIssuerPort;
import io.hydropark.port.Ports.SettlementLogPort;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * The in-process License Issuer (BACKEND-DESIGN §6.2) - the security keystone. Gated on
 * {@code hydropark.issuer.enabled=true}: it exists only in the isolated issuer zone that holds the
 * Ed25519 private keys.
 *
 * <p><b>Isolation is not authorization.</b> Before it signs, it re-verifies everything itself,
 * <em>regardless of which internal caller asked</em> - the internal-network boundary is not a
 * permission:
 *
 * <ol>
 *   <li>An <b>active grant for exactly this {@code (user, skill)}</b> whose {@code order_id} has a
 *       row in {@code settled_orders} (via {@link SettlementLogPort}). Binding to the exact pair -
 *       not "some settled order exists for this user" - is what stops a compromised internal caller
 *       from minting an arbitrary-skill license by citing an unrelated settled order.
 *   <li>A live device slot ({@link DeviceSlotPort#assertActiveSlot}); {@code device_binding} is
 *       taken server-side from {@link DeviceSlotPort#fingerprintOf}, never from the client.
 *   <li>Per-{@code sub} rate limit (primary) + a wide global backstop.
 * </ol>
 *
 * Every sign is audited. The private key is never logged, echoed, or returned. Idempotent re-issue
 * returns the current active token rather than minting a second.
 */
@Service
@ConditionalOnProperty(name = "hydropark.issuer.enabled", havingValue = "true")
public class LocalLicenseIssuer implements LicenseIssuerPort {

  private static final Logger log = LoggerFactory.getLogger(LocalLicenseIssuer.class);

  private final LicenseSigner signer;
  private final GrantRepository grants;
  private final LicenseRepository licenses;
  private final LicenseAuditRepository audits;
  private final SettlementLogPort settlementLog;
  private final DeviceSlotPort deviceSlot;
  private final IssuanceRateLimiter rateLimiter;

  public LocalLicenseIssuer(
      LicenseSigner signer,
      GrantRepository grants,
      LicenseRepository licenses,
      LicenseAuditRepository audits,
      SettlementLogPort settlementLog,
      DeviceSlotPort deviceSlot,
      IssuanceRateLimiter rateLimiter) {
    this.signer = signer;
    this.grants = grants;
    this.licenses = licenses;
    this.audits = audits;
    this.settlementLog = settlementLog;
    this.deviceSlot = deviceSlot;
    this.rateLimiter = rateLimiter;
  }

  @Override
  @Transactional
  public IssuedLicense issue(String userId, String skillId, String deviceId) {
    // Idempotent re-issue: an existing live license for this (user, skill, device) is returned as-is
    // (no new sign, no rate-budget consumed). Perpetual tokens are additive, so this is safe.
    Optional<License> existing =
        licenses.findByUserIdAndSkillIdAndDeviceIdAndStatus(userId, skillId, deviceId, "active");
    if (existing.isPresent()) {
      License l = existing.get();
      return new IssuedLicense(l.getId(), l.getToken(), l.getSigningKeyId());
    }

    // (1) Authorization keystone: an active grant for the EXACT (user, skill) whose order settled.
    requireSettledGrant(userId, skillId);

    // (2) Device slot + server-derived binding.
    deviceSlot.assertActiveSlot(userId, deviceId);
    String binding = deviceSlot.fingerprintOf(deviceId);

    // (3) Rate limit (primary per-sub, wide global backstop) - only gates real mints.
    rateLimiter.check(userId);

    // (4) Sign. license_id is embedded in the token AND is the license row's _id.
    String licenseId = Uuid7.prefixed("lic");
    LicenseSigner.Signed signed = signer.sign(licenseId, userId, skillId, deviceId, binding);

    License lic =
        License.active(
            licenseId, userId, skillId, deviceId, signed.kid(), signed.token(), Instant.now());
    try {
      licenses.insert(lic);
    } catch (DuplicateKeyException race) {
      // A concurrent issue won the (user, skill, device) WHERE active partial-unique index.
      // Return the winner rather than minting a second live license.
      License winner =
          licenses
              .findByUserIdAndSkillIdAndDeviceIdAndStatus(userId, skillId, deviceId, "active")
              .orElseThrow(() -> race);
      return new IssuedLicense(winner.getId(), winner.getToken(), winner.getSigningKeyId());
    }

    // (5) Audit every sign.
    audits.save(
        LicenseAudit.of(
            Uuid7.generate(),
            licenseId,
            signed.kid(),
            IssuanceRateLimiter.CALLER_ISSUE,
            userId,
            skillId,
            deviceId,
            Instant.now()));

    log.info("issued license {} kid={} sub={} skill={} device={}", licenseId, signed.kid(), userId, skillId, deviceId);
    return new IssuedLicense(licenseId, signed.token(), signed.kid());
  }

  /**
   * The exact-pair settlement binding. An active grant for {@code (user, skill)} is necessary but not
   * sufficient - its {@code order_id} must also appear in {@code settled_orders}. A caller who cites a
   * settled order for a <em>different</em> skill fails here, because there is no active grant for
   * <em>this</em> skill pointing at a settled order.
   */
  private void requireSettledGrant(String userId, String skillId) {
    List<Grant> active =
        grants.findByUserIdAndSkillIdAndStatus(userId, skillId, GrantStatus.ACTIVE.wire());
    boolean settled = active.stream().anyMatch(g -> settlementLog.isSettledOrder(g.getOrderId()));
    if (!settled) {
      throw ApiException.notEntitled(skillId);
    }
  }
}
