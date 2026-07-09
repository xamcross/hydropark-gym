package io.hydropark.devices;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import io.hydropark.common.ApiException;
import io.hydropark.common.ErrorCode;
import io.hydropark.config.AppProperties;
import io.hydropark.port.Ports;
import java.time.Instant;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.springframework.data.mongodb.core.FindAndModifyOptions;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Query;

/**
 * Unit tests for the device slot cap and match-or-create reclaim (BE §3.4, AGENT-CONTRACT). Mocked
 * collaborators - the assertions are about which slot-counter operations fire, since that is exactly
 * where a naive implementation leaks slots on reinstall. NOT RUN by this agent, per the contract.
 */
class DeviceServiceTest {

  private final MongoTemplate mongo = mock(MongoTemplate.class);
  private final DeviceRepository devices = mock(DeviceRepository.class);
  private final DeviceSlotCounters counters = mock(DeviceSlotCounters.class);
  private final RotationVelocityDetector velocity = mock(RotationVelocityDetector.class);
  private final Ports.StepUpPort stepUp = mock(Ports.StepUpPort.class);
  private final AppProperties props = new AppProperties(); // defaults: maxActiveSlots=5

  private final DeviceService service =
      new DeviceService(mongo, devices, counters, velocity, stepUp, props);

  private static Device device(String id, String status) {
    Instant now = Instant.now();
    return new Device(id, "u1", "My device", "fp-1", status, now, now);
  }

  /**
   * The reinstall / OS-move path: the same coarse fingerprint already maps to an ACTIVE slot. It
   * must be reclaimed WITHOUT consuming a second slot - no counter claim, no lifetime bump, no churn
   * event.
   */
  @Test
  void reinstallWithSameFingerprintReclaimsExistingSlot() {
    when(devices.findByUserIdAndFingerprint("u1", "fp-1"))
        .thenReturn(Optional.of(device("d1", Device.ACTIVE)));
    when(mongo.findAndModify(any(Query.class), any(), any(FindAndModifyOptions.class), eq(Device.class)))
        .thenReturn(device("d1", Device.ACTIVE));

    Device result = service.register("u1", "Laptop", "fp-1", "step-up");

    assertThatIsD1(result);
    // The load-bearing assertion: a reinstall does not touch the slot counter at all.
    verify(counters, never()).tryClaim(anyString(), anyInt());
    verify(counters, never()).incLifetime(anyString());
    verify(velocity, never()).record(anyString(), anyString());
    verify(devices, never()).insert(any(Device.class));
  }

  /**
   * The 6th distinct device is rejected: a genuinely new fingerprint claims a slot via the atomic
   * counter, and a null result (already at the cap of 5) maps to SLOT_LIMIT_REACHED. No device row
   * is inserted, no lifetime bump.
   */
  @Test
  void sixthDistinctDeviceIsRejectedWithSlotLimitReached() {
    when(devices.findByUserIdAndFingerprint("u1", "fp-1")).thenReturn(Optional.empty());
    when(counters.tryClaim("u1", 5)).thenReturn(null); // cap reached

    assertThatThrownBy(() -> service.register("u1", "New device", "fp-1", "step-up"))
        .isInstanceOf(ApiException.class)
        .extracting(e -> ((ApiException) e).errorCode())
        .isEqualTo(ErrorCode.SLOT_LIMIT_REACHED);

    verify(devices, never()).insert(any(Device.class));
    verify(counters, never()).incLifetime(anyString());
    verify(velocity, never()).record(anyString(), anyString());
  }

  /**
   * A genuinely new fingerprint under the cap consumes exactly one slot, bumps the lifetime count,
   * and records a new-device churn event.
   */
  @Test
  void newDeviceUnderCapConsumesOneSlotAndCounts() {
    when(devices.findByUserIdAndFingerprint("u1", "fp-1")).thenReturn(Optional.empty());
    when(counters.tryClaim("u1", 5)).thenReturn(new DeviceSlotCounter());

    Device result = service.register("u1", "New device", "fp-1", "step-up");

    assertThatIsD1OrNew(result);
    verify(counters).tryClaim("u1", 5);
    verify(counters).incLifetime("u1");
    verify(velocity).record("u1", RotationVelocityDetector.NEW_DEVICE);
    verify(devices).insert(any(Device.class));
  }

  /**
   * A previously deauthorized device coming back must pass the cap (it consumes a slot) and is
   * counted as rotation churn.
   */
  @Test
  void reactivatingDeauthorizedDeviceClaimsSlotAndCountsChurn() {
    when(devices.findByUserIdAndFingerprint("u1", "fp-1"))
        .thenReturn(Optional.of(device("d1", Device.DEAUTHORIZED)));
    when(counters.tryClaim("u1", 5)).thenReturn(new DeviceSlotCounter());
    when(mongo.findAndModify(any(Query.class), any(), any(FindAndModifyOptions.class), eq(Device.class)))
        .thenReturn(device("d1", Device.ACTIVE));

    service.register("u1", null, "fp-1", "step-up");

    verify(counters).tryClaim("u1", 5);
    verify(velocity).record("u1", RotationVelocityDetector.REACTIVATE);
    // Reactivation is not a brand-new device, so lifetime distinct-device count is NOT bumped.
    verify(counters, never()).incLifetime(anyString());
  }

  /**
   * Registration is step-up gated (SF11): a perpetual device slot must not be mintable from a
   * 15-minute access token alone. The step-up check runs before any slot work.
   */
  @Test
  void registrationIsStepUpGated() {
    when(devices.findByUserIdAndFingerprint("u1", "fp-1"))
        .thenReturn(Optional.of(device("d1", Device.ACTIVE)));
    when(mongo.findAndModify(any(Query.class), any(), any(FindAndModifyOptions.class), eq(Device.class)))
        .thenReturn(device("d1", Device.ACTIVE));

    service.register("u1", "Laptop", "fp-1", "the-step-up-token");

    verify(stepUp).assertStepUp("u1", "the-step-up-token", Ports.StepUpActions.DEVICE_REGISTER);
  }

  /**
   * Deauthorizing the LAST active device is itself step-up gated - it is the trust-root reset path
   * (Q4). With one active device remaining, step-up must be asserted.
   */
  @Test
  void deauthorizingLastActiveDeviceIsStepUpGated() {
    when(devices.findById("d1")).thenReturn(Optional.of(device("d1", Device.ACTIVE)));
    when(mongo.count(any(Query.class), eq(Device.class))).thenReturn(1L); // this is the last one
    when(mongo.findAndModify(any(Query.class), any(), any(FindAndModifyOptions.class), eq(Device.class)))
        .thenReturn(device("d1", Device.DEAUTHORIZED));

    service.deauthorize("u1", "d1", "last-device-step-up");

    verify(stepUp)
        .assertStepUp("u1", "last-device-step-up", Ports.StepUpActions.DEVICE_DEAUTHORIZE_LAST);
    verify(counters).release("u1");
  }

  /** Deauthorizing when other active devices remain does NOT require step-up. */
  @Test
  void deauthorizingNonLastDeviceSkipsStepUp() {
    when(devices.findById("d1")).thenReturn(Optional.of(device("d1", Device.ACTIVE)));
    when(mongo.count(any(Query.class), eq(Device.class))).thenReturn(3L);
    when(mongo.findAndModify(any(Query.class), any(), any(FindAndModifyOptions.class), eq(Device.class)))
        .thenReturn(device("d1", Device.DEAUTHORIZED));

    service.deauthorize("u1", "d1", null);

    verify(stepUp, never()).assertStepUp(anyString(), any(), anyString());
    verify(counters).release("u1");
  }

  /** A device owned by another user is FORBIDDEN, never touched. */
  @Test
  void deauthorizingAnotherUsersDeviceIsForbidden() {
    Device otherUsers = new Device("d9", "someone-else", "x", "fp", Device.ACTIVE, Instant.now(), Instant.now());
    when(devices.findById("d9")).thenReturn(Optional.of(otherUsers));

    assertThatThrownBy(() -> service.deauthorize("u1", "d9", null))
        .isInstanceOf(ApiException.class)
        .extracting(e -> ((ApiException) e).errorCode())
        .isEqualTo(ErrorCode.FORBIDDEN);

    verify(counters, never()).release(anyString());
  }

  private static void assertThatIsD1(Device d) {
    org.assertj.core.api.Assertions.assertThat(d.getId()).isEqualTo("d1");
  }

  private static void assertThatIsD1OrNew(Device d) {
    org.assertj.core.api.Assertions.assertThat(d).isNotNull();
  }
}
