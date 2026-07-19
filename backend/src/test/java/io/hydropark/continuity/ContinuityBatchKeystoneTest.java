package io.hydropark.continuity;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import io.hydropark.devices.Device;
import io.hydropark.devices.DeviceRepository;
import io.hydropark.licensing.Grant;
import io.hydropark.licensing.GrantRepository;
import io.hydropark.licensing.IssuanceRateLimiter;
import io.hydropark.licensing.License;
import io.hydropark.licensing.LicenseAuditRepository;
import io.hydropark.licensing.LicenseRepository;
import io.hydropark.licensing.LicenseSigner;
import io.hydropark.licensing.LocalLicenseIssuer;
import io.hydropark.port.Ports.DeviceSlotPort;
import io.hydropark.port.Ports.GrantSource;
import io.hydropark.port.Ports.GrantStatus;
import io.hydropark.port.Ports.SettlementLogPort;
import io.hydropark.registry.RegistryProperties;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

/**
 * <b>The key safety test.</b> The whole point of building the batch on top of {@link
 * LocalLicenseIssuer} rather than a fresh signing path is that the settled-grant keystone still gates
 * every signature. Here the batch is <em>fully</em> dual-control approved and does attempt a mint - but
 * against a candidate grant whose order never settled. A <b>real</b> {@link LocalLicenseIssuer} (only
 * its collaborators mocked) is wired in, so the refusal is the production keystone's, not a stub's.
 *
 * <p>The assertion that matters: the {@link LicenseSigner} is <b>never called</b>. The batch cannot
 * mint a token without an effective, settled entitlement - it has no way around the keystone, because
 * it goes through it. Pure Mockito; no Docker.
 */
@ExtendWith(MockitoExtension.class)
class ContinuityBatchKeystoneTest {

  @Mock ContinuityBatchRepository batches;
  @Mock GrantRepository grants;
  @Mock DeviceRepository devices;

  // The real Issuer's collaborators - mocked so we can observe the signer and force settlement state.
  @Mock LicenseSigner signer;
  @Mock LicenseRepository licenses;
  @Mock LicenseAuditRepository audits;
  @Mock SettlementLogPort settlementLog;
  @Mock DeviceSlotPort deviceSlot;
  @Mock IssuanceRateLimiter rateLimiter;

  private static final String ADMIN_A = "admin-a";
  private static final String ADMIN_B = "admin-b";

  @Test
  void anApprovedBatchStillCannotMintWithoutAnEffectiveSettledEntitlement() {
    // A REAL Issuer: the same requireSettledGrant keystone a user unlock hits.
    LocalLicenseIssuer realIssuer =
        new LocalLicenseIssuer(
            signer, grants, licenses, audits, settlementLog, deviceSlot, rateLimiter);

    RegistryProperties admins = new RegistryProperties();
    admins.setAdminUserIds(List.of(ADMIN_A, ADMIN_B));

    ContinuityBatchService svc =
        new ContinuityBatchService(batches, grants, devices, realIssuer, admins);

    // A dual-control-APPROVED batch: this is not a dual-control failure, it is an entitlement failure.
    ContinuityBatch batch = ContinuityBatch.open(ADMIN_A, Instant.now());
    batch.setId("cb1");
    batch.getApprovals().add(new ContinuityBatch.Approval(ADMIN_A, Instant.now()));
    batch.getApprovals().add(new ContinuityBatch.Approval(ADMIN_B, Instant.now()));
    batch.setStatus(ContinuityBatch.STATUS_APPROVED);
    when(batches.findById("cb1")).thenReturn(Optional.of(batch));
    when(batches.save(org.mockito.ArgumentMatchers.any(ContinuityBatch.class)))
        .thenAnswer(inv -> inv.getArgument(0));

    // A candidate active grant exists, so the batch WILL try to mint (user1, skillA, dev1)...
    Grant g1 =
        Grant.create(
            "g1", "user1", "skillA", GrantSource.STANDALONE, "O1", "mor", "USD", 500, Instant.now());
    when(grants.findByStatus(GrantStatus.ACTIVE.wire())).thenReturn(List.of(g1));
    when(devices.findByUserIdAndStatus("user1", Device.ACTIVE))
        .thenReturn(List.of(device("dev1", "user1")));

    // ...but the Issuer's keystone rejects it: the grant's order O1 never settled.
    when(licenses.findByUserIdAndSkillIdAndDeviceIdAndStatus("user1", "skillA", "dev1", "active"))
        .thenReturn(Optional.<License>empty());
    when(grants.findByUserIdAndSkillIdAndStatus("user1", "skillA", GrantStatus.ACTIVE.wire()))
        .thenReturn(List.of(g1));
    when(settlementLog.isSettledOrder("O1")).thenReturn(false);

    ContinuityBatchResult result = svc.runApprovedBatch("cb1", ADMIN_A);

    // Nothing was minted, and - the crux - the sacred signer was never invoked.
    assertThat(result.minted()).isZero();
    assertThat(result.skipped()).isEqualTo(1);
    assertThat(result.licenseIds()).isEmpty();
    verify(signer, never())
        .sign(anyString(), anyString(), anyString(), anyString(), anyString());
    verify(deviceSlot, never()).fingerprintOf(anyString());
  }

  private static Device device(String id, String userId) {
    return new Device(id, userId, "My device", "fp-" + id, Device.ACTIVE, Instant.now(), Instant.now());
  }
}
