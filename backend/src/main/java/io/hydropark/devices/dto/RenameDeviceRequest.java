package io.hydropark.devices.dto;

import jakarta.validation.constraints.NotBlank;

/** BE §4.6 - {@code PATCH /v1/devices/{id}} body. */
public record RenameDeviceRequest(@NotBlank String name) {}
