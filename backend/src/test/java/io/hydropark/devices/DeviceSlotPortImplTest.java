package io.hydropark.devices;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import io.hydropark.common.ApiException;
import io.hydropark.common.ErrorCode;
import io.hydropark.config.AppProperties;
import java.time.Instant;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Query;

/**
 * Unit tests for {@link DeviceSlotPortImpl} - the seam {@code licensing} calls at issuance (BE §3.4,
 * §6.1). NOT RUN by this agent, per the contract.
 */
class DeviceSlotPortImplTest {

  private final MongoTemplate mongo = mock(MongoTemplate.class);
  private final DeviceRepository devices = mock(DeviceRepository.class);
  private final DeviceSlotPortImpl port =
      new DeviceSlotPortImpl(mongo, devices, new AppProperties());

  private static Device device(String id, String userId, String status) {
    Instant now = Instant.now();
    return new Device(id, userId, "My device", "coarse-fp", status, now, now);
  }

  @Test
  void assertActiveSlotPassesForOwnedActiveDeviceWithinCap() {
    when(devices.findById("d1")).thenReturn(Optional.of(device("d1", "u1", Device.ACTIVE)));
    when(mongo.count(any(Query.class), eq(Device.class))).thenReturn(3L);

    // does not throw
    port.assertActiveSlot("u1", "d1");
  }

  @Test
  void assertActiveSlotUnknownDeviceIsNotFound() {
    when(devices.findById("missing")).thenReturn(Optional.empty());

    assertThatThrownBy(() -> port.assertActiveSlot("u1", "missing"))
        .isInstanceOf(ApiException.class)
        .extracting(e -> ((ApiException) e).errorCode())
        .isEqualTo(ErrorCode.NOT_FOUND);
  }

  @Test
  void assertActiveSlotForeignDeviceIsForbidden() {
    when(devices.findById("d1")).thenReturn(Optional.of(device("d1", "someone-else", Device.ACTIVE)));

    assertThatThrownBy(() -> port.assertActiveSlot("u1", "d1"))
        .isInstanceOf(ApiException.class)
        .extracting(e -> ((ApiException) e).errorCode())
        .isEqualTo(ErrorCode.FORBIDDEN);
  }

  @Test
  void assertActiveSlotDeauthorizedDeviceIsNotAnActiveSlot() {
    when(devices.findById("d1")).thenReturn(Optional.of(device("d1", "u1", Device.DEAUTHORIZED)));

    assertThatThrownBy(() -> port.assertActiveSlot("u1", "d1"))
        .isInstanceOf(ApiException.class)
        .extracting(e -> ((ApiException) e).errorCode())
        .isEqualTo(ErrorCode.NOT_FOUND);
  }

  @Test
  void fingerprintOfReturnsCoarseServerSideFingerprint() {
    when(devices.findById("d1")).thenReturn(Optional.of(device("d1", "u1", Device.ACTIVE)));

    assertThat(port.fingerprintOf("d1")).isEqualTo("coarse-fp");
  }

  @Test
  void fingerprintOfUnknownDeviceIsNotFound() {
    when(devices.findById("missing")).thenReturn(Optional.empty());

    assertThatThrownBy(() -> port.fingerprintOf("missing"))
        .isInstanceOf(ApiException.class)
        .extracting(e -> ((ApiException) e).errorCode())
        .isEqualTo(ErrorCode.NOT_FOUND);
  }
}
