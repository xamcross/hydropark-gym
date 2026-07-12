package io.hydropark.continuity;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import io.hydropark.common.ApiException;
import io.hydropark.common.ErrorCode;
import io.hydropark.devices.Device;
import io.hydropark.devices.DeviceRepository;
import io.hydropark.licensing.Grant;
import io.hydropark.licensing.GrantRepository;
import io.hydropark.licensing.IssuanceRateLimiter;
import io.hydropark.licensing.LocalLicenseIssuer;
import io.hydropark.port.Ports.GrantSource;
import io.hydropark.port.Ports.GrantStatus;
import io.hydropark.port.Ports.IssuedLicense;
import io.hydropark.registry.RegistryProperties;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

/**
 * The P1-23.1 dual-control invariant: a mass pre-mint is gated behind <b>two distinct admin
 * approvals</b>, and the mint itself goes through the existing Issuer - the service never signs. These
 * tests pin the control with a mocked {@link LocalLicenseIssuer} so they observe exactly whether a
 * mint was attempted; the companion {@link ContinuityBatchKeystoneTest} proves that even when a mint
 * <em>is</em> attempted, the real Issuer refuses a non-entitled pair.
 *
 * <p>Pure Mockito; no Docker.
 */
@ExtendWith(MockitoExtension.class)
class ContinuityBatchServiceTest {

  @Mock ContinuityBatchRepository batches;
  @Mock GrantRepository grants;
  @Mock DeviceRepository devices;
  @Mock LocalLicenseIssuer issuer;

  private static final String ADMIN_A = "admin-a";
  private static final String ADMIN_B = "admin-b";
  private static final String OUTSIDER = "not-an-admin";

  private RegistryProperties admins() {
    RegistryProperties props = new RegistryProperties();
    props.setAdminUserIds(List.of(ADMIN_A, ADMIN_B));
    return props;
  }

  private ContinuityBatchService service() {
    return new ContinuityBatchService(batches, grants, devices, issuer, admins());
  }

  private ContinuityBatch persisted(ContinuityBatch batch, String id) {
    batch.setId(id);
    when(batches.findById(id)).thenReturn(Optional.of(batch));
    when(batches.save(any(ContinuityBatch.class))).thenAnswer(inv -> inv.getArgument(0));
    return batch;
  }

  @Test
  void aSingleApprovalDoesNotMint() {
    ContinuityBatch batch = ContinuityBatch.open(ADMIN_A, Instant.now());
    persisted(batch, "cb1");

    ContinuityBatchService svc = service();
    svc.approve("cb1", ADMIN_A); // exactly one approval

    // Running now must refuse BEFORE any mint is attempted - one approval is not dual control.
    assertThatThrownBy(() -> svc.runApprovedBatch("cb1", ADMIN_A))
        .isInstanceOf(ApiException.class)
        .extracting(e -> ((ApiException) e).errorCode())
        .isEqualTo(ErrorCode.FORBIDDEN);

    verify(issuer, never()).issue(anyString(), anyString(), anyString(), anyString());
    assertThat(batch.getStatus()).isEqualTo(ContinuityBatch.STATUS_PENDING_APPROVAL);
  }

  @Test
  void twoDistinctApprovalsMintThroughTheIssuer() {
    ContinuityBatch batch = ContinuityBatch.open(ADMIN_A, Instant.now());
    persisted(batch, "cb1");

    // One active grant (user1, skillA) and one active device -> exactly one target.
    when(grants.findByStatus(GrantStatus.ACTIVE.wire()))
        .thenReturn(
            List.of(
                Grant.create(
                    "g1", "user1", "skillA", GrantSource.STANDALONE, "O1", "mor", "USD", 500,
                    Instant.now())));
    when(devices.findByUserIdAndStatus("user1", Device.ACTIVE))
        .thenReturn(List.of(device("dev1", "user1")));
    when(issuer.issue("user1", "skillA", "dev1", IssuanceRateLimiter.CALLER_BATCH_PREMINT))
        .thenReturn(new IssuedLicense("lic1", "token", "kid"));

    ContinuityBatchService svc = service();
    svc.approve("cb1", ADMIN_A);
    svc.approve("cb1", ADMIN_B); // second DISTINCT admin -> dual control satisfied
    assertThat(batch.getStatus()).isEqualTo(ContinuityBatch.STATUS_APPROVED);

    ContinuityBatchResult result = svc.runApprovedBatch("cb1", ADMIN_A);

    verify(issuer)
        .issue("user1", "skillA", "dev1", IssuanceRateLimiter.CALLER_BATCH_PREMINT);
    assertThat(result.minted()).isEqualTo(1);
    assertThat(result.skipped()).isZero();
    assertThat(result.licenseIds()).containsExactly("lic1");
    assertThat(batch.getStatus()).isEqualTo(ContinuityBatch.STATUS_COMPLETED);
    assertThat(batch.getMintedCount()).isEqualTo(1);
  }

  @Test
  void theSameAdminCannotApproveTwice() {
    ContinuityBatch batch = ContinuityBatch.open(ADMIN_A, Instant.now());
    persisted(batch, "cb1");

    ContinuityBatchService svc = service();
    svc.approve("cb1", ADMIN_A);

    // A second approval from the SAME admin is rejected - it would fake two-person control.
    assertThatThrownBy(() -> svc.approve("cb1", ADMIN_A))
        .isInstanceOf(ApiException.class)
        .extracting(e -> ((ApiException) e).errorCode())
        .isEqualTo(ErrorCode.CONFLICT);
    assertThat(batch.distinctApprovalCount()).isEqualTo(1);
    assertThat(batch.getStatus()).isEqualTo(ContinuityBatch.STATUS_PENDING_APPROVAL);
  }

  @Test
  void nonAdminsCannotApproveOrRun() {
    ContinuityBatch batch = ContinuityBatch.open(ADMIN_A, Instant.now());
    batch.setId("cb1");
    // No repository stubbing needed: the admin gate rejects before any load.

    ContinuityBatchService svc = service();
    assertThatThrownBy(() -> svc.approve("cb1", OUTSIDER))
        .isInstanceOf(ApiException.class)
        .extracting(e -> ((ApiException) e).errorCode())
        .isEqualTo(ErrorCode.FORBIDDEN);
    assertThatThrownBy(() -> svc.runApprovedBatch("cb1", OUTSIDER))
        .isInstanceOf(ApiException.class)
        .extracting(e -> ((ApiException) e).errorCode())
        .isEqualTo(ErrorCode.FORBIDDEN);
    verify(issuer, never()).issue(anyString(), anyString(), anyString(), anyString());
  }

  private static Device device(String id, String userId) {
    return new Device(id, userId, "My device", "fp-" + id, Device.ACTIVE, Instant.now(), Instant.now());
  }
}
