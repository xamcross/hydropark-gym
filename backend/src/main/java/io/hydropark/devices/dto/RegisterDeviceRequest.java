package io.hydropark.devices.dto;

import jakarta.validation.constraints.NotBlank;

/**
 * BE §4.6 - {@code POST /v1/devices/register} body. The client supplies a coarse fingerprint the
 * server stores as-is; it is never re-derived offline (§13.12).
 */
public record RegisterDeviceRequest(String name, @NotBlank String fingerprint) {}
