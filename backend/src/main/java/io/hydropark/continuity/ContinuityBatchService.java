package io.hydropark.continuity;

import io.hydropark.common.ApiException;
import io.hydropark.common.ErrorCode;
import io.hydropark.devices.Device;
import io.hydropark.devices.DeviceRepository;
import io.hydropark.licensing.Grant;
import io.hydropark.licensing.GrantRepository;
import io.hydropark.licensing.IssuanceRateLimiter;
import io.hydropark.licensing.LocalLicenseIssuer;
import io.hydropark.port.Ports.GrantStatus;
import io.hydropark.port.Ports.IssuedLicense;
import io.hydropark.registry.RegistryProperties;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Service;

/**
 * The P1-23.1 business-continuity <b>batch pre-mint</b>: a server-side job that, for every effective
 * entitlement × registered device, pre-signs the license the customer would otherwise have to fetch
 * live - so if the issuer zone ever goes dark, customers already hold the tokens their devices need.
 *
 * <p><b>Two invariants make this safe to build at all:</b>
 *
 * <ol>
 *   <li><b>Dual control.</b> A mass pre-mint is never one operator's call. A batch must be opened and
 *       then approved by <em>two distinct</em> registry admins ({@link ContinuityBatch}); {@link
 *       #runApprovedBatch} refuses to mint until that gate is met. A single approval mints nothing.
 *   <li><b>The keystone is not bypassed.</b> Every mint goes through the <em>existing</em> {@link
 *       LocalLicenseIssuer} authorization path - the same {@code requireSettledGrant} check a user
 *       unlock hits. The batch derives its candidate targets from {@code active} grants, but the
 *       Issuer independently re-confirms the exact-pair settled order before signing; a candidate
 *       whose order never settled is <b>refused</b> and counted as skipped, never signed. There is no
 *       new privileged signing path here - only a caller tag ({@link
 *       IssuanceRateLimiter#CALLER_BATCH_PREMINT}) that audits the batch distinctly and exempts it
 *       from the anti-oracle rate limit.
 * </ol>
 *
 * <p>Gated on {@code hydropark.issuer.enabled=true}: it depends on {@link LocalLicenseIssuer}, which
 * exists only in the isolated issuer zone that holds signing material. It is therefore inherently
 * server-side and never reachable from a client.
 */
@Service
@ConditionalOnProperty(name = "hydropark.issuer.enabled", havingValue = "true")
public class ContinuityBatchService {

  private static final Logger log = LoggerFactory.getLogger(ContinuityBatchService.class);

  private final ContinuityBatchRepository batches;
  private final GrantRepository grants;
  private final DeviceRepository devices;
  private final LocalLicenseIssuer issuer;
  private final RegistryProperties admins;

  public ContinuityBatchService(
      ContinuityBatchRepository batches,
      GrantRepository grants,
      DeviceRepository devices,
      LocalLicenseIssuer issuer,
      RegistryProperties admins) {
    this.batches = batches;
    this.grants = grants;
    this.devices = devices;
    this.issuer = issuer;
    this.admins = admins;
  }

  /** Open a new batch awaiting dual-control approval. Restricted to registry admins. */
  public ContinuityBatch openBatch(String adminUserId) {
    requireAdmin(adminUserId);
    ContinuityBatch batch = ContinuityBatch.open(adminUserId, Instant.now());
    return batches.save(batch);
  }

  /**
   * Record one admin's approval. Restricted to registry admins; an admin cannot approve the same
   * batch twice (that would defeat the two-person rule), and an already-completed batch cannot be
   * re-approved. The batch flips to {@link ContinuityBatch#STATUS_APPROVED} once two distinct admins
   * have approved - but approval alone <b>mints nothing</b>; the mint is the separate {@link
   * #runApprovedBatch} step.
   */
  public ContinuityBatch approve(String batchId, String adminUserId) {
    requireAdmin(adminUserId);
    ContinuityBatch batch = load(batchId);
    if (ContinuityBatch.STATUS_COMPLETED.equals(batch.getStatus())) {
      throw new ApiException(ErrorCode.CONFLICT, "continuity batch already completed");
    }
    if (batch.hasApprovalFrom(adminUserId)) {
      throw new ApiException(
          ErrorCode.CONFLICT,
          "admin has already approved this batch; dual control requires two distinct admins");
    }
    batch.getApprovals().add(new ContinuityBatch.Approval(adminUserId, Instant.now()));
    if (batch.hasEnoughApprovals()) {
      batch.setStatus(ContinuityBatch.STATUS_APPROVED);
    }
    return batches.save(batch);
  }

  /**
   * Run an approved batch: pre-mint one license per (effective entitlement × active device). Restricted
   * to registry admins. <b>The dual-control gate is enforced first</b> - the batch must carry two
   * distinct approvals ({@link ContinuityBatch#STATUS_APPROVED}); otherwise this throws before any
   * mint runs. Each mint delegates to {@link LocalLicenseIssuer}, so the settled-grant keystone gates
   * every signature; a target the Issuer refuses is counted as skipped, never signed.
   */
  public ContinuityBatchResult runApprovedBatch(String batchId, String adminUserId) {
    requireAdmin(adminUserId);
    ContinuityBatch batch = load(batchId);

    if (ContinuityBatch.STATUS_COMPLETED.equals(batch.getStatus())) {
      throw new ApiException(ErrorCode.CONFLICT, "continuity batch already completed");
    }
    // Dual-control gate: refuse to mint anything without two distinct approvals recorded.
    if (!batch.hasEnoughApprovals()) {
      throw new ApiException(
          ErrorCode.FORBIDDEN,
          "continuity batch is not dual-control approved: "
              + batch.distinctApprovalCount()
              + " of "
              + batch.getRequiredApprovals()
              + " required approvals");
    }

    int minted = 0;
    int skipped = 0;
    List<String> licenseIds = new ArrayList<>();

    for (Map.Entry<String, Set<String>> e : effectiveEntitlements().entrySet()) {
      String userId = e.getKey();
      List<Device> activeDevices = devices.findByUserIdAndStatus(userId, Device.ACTIVE);
      for (String skillId : e.getValue()) {
        for (Device device : activeDevices) {
          try {
            // The one keystone: LocalLicenseIssuer re-confirms the exact-pair settled order itself.
            IssuedLicense lic =
                issuer.issue(
                    userId, skillId, device.getId(), IssuanceRateLimiter.CALLER_BATCH_PREMINT);
            licenseIds.add(lic.licenseId());
            minted++;
          } catch (ApiException refused) {
            // Keystone (or slot cap) refused this target. Resilient: skip and keep going - one
            // ineligible pair must not abort the whole continuity run.
            skipped++;
            log.info(
                "continuity batch {} skipped user={} skill={} device={}: {}",
                batchId,
                userId,
                skillId,
                device.getId(),
                refused.errorCode().code());
          }
        }
      }
    }

    batch.setStatus(ContinuityBatch.STATUS_COMPLETED);
    batch.setCompletedAt(Instant.now());
    batch.setMintedCount(minted);
    batches.save(batch);

    log.info("continuity batch {} completed: minted={} skipped={}", batchId, minted, skipped);
    return new ContinuityBatchResult(batchId, minted, skipped, licenseIds);
  }

  /**
   * The candidate targets: {@code user -> distinct owned skills}, derived from {@code active} grants.
   * A user may hold several active grants for one skill (standalone + bundle), so skills are deduped
   * per user. This is only a candidate set; the Issuer re-authorizes each pair before signing.
   */
  private Map<String, Set<String>> effectiveEntitlements() {
    Map<String, Set<String>> bySkill = new LinkedHashMap<>();
    for (Grant g : grants.findByStatus(GrantStatus.ACTIVE.wire())) {
      bySkill.computeIfAbsent(g.getUserId(), k -> new LinkedHashSet<>()).add(g.getSkillId());
    }
    return bySkill;
  }

  private ContinuityBatch load(String batchId) {
    return batches
        .findById(batchId)
        .orElseThrow(() -> ApiException.notFound("continuity batch " + batchId));
  }

  private void requireAdmin(String adminUserId) {
    if (!admins.isAdmin(adminUserId)) {
      throw new ApiException(
          ErrorCode.FORBIDDEN, "continuity batch control is restricted to registry administrators");
    }
  }
}
