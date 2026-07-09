package io.hydropark.devices;

import io.hydropark.common.CursorPage;
import io.hydropark.devices.dto.DeviceView;
import io.hydropark.devices.dto.RegisterDeviceRequest;
import io.hydropark.devices.dto.RenameDeviceRequest;
import io.hydropark.security.CurrentUser;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * BE §4.6 device registry endpoints. All require a valid access token ({@code SecurityConfig}'s
 * {@code anyRequest().authenticated()}). Register - and deauthorizing the last active device - are
 * additionally step-up gated inside {@link DeviceService}, using the {@code X-Step-Up-Token} header.
 */
@RestController
@RequestMapping("/v1/devices")
public class DeviceController {

  /** Step-up proof header (BE §8 SF11). Absent -> the {@code StepUpPort} fails closed. */
  private static final String STEP_UP_HEADER = "X-Step-Up-Token";

  private final DeviceService devices;

  public DeviceController(DeviceService devices) {
    this.devices = devices;
  }

  @PostMapping("/register")
  public DeviceView register(
      @Valid @RequestBody RegisterDeviceRequest body,
      @RequestHeader(value = STEP_UP_HEADER, required = false) String stepUpToken) {
    String userId = CurrentUser.requireUserId();
    return DeviceView.of(devices.register(userId, body.name(), body.fingerprint(), stepUpToken));
  }

  @GetMapping
  public CursorPage<DeviceView> list(
      @RequestParam(required = false) Integer limit,
      @RequestParam(required = false) String cursor) {
    String userId = CurrentUser.requireUserId();
    CursorPage<Device> page = devices.list(userId, limit, cursor);
    return new CursorPage<>(page.items().stream().map(DeviceView::of).toList(), page.nextCursor());
  }

  @PatchMapping("/{deviceId}")
  public DeviceView rename(
      @PathVariable String deviceId, @Valid @RequestBody RenameDeviceRequest body) {
    String userId = CurrentUser.requireUserId();
    return DeviceView.of(devices.rename(userId, deviceId, body.name()));
  }

  @PostMapping("/{deviceId}/deauthorize")
  public DeviceView deauthorize(
      @PathVariable String deviceId,
      @RequestHeader(value = STEP_UP_HEADER, required = false) String stepUpToken) {
    String userId = CurrentUser.requireUserId();
    return DeviceView.of(devices.deauthorize(userId, deviceId, stepUpToken));
  }
}
