package io.hydropark.devices;

import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * Enables Spring's scheduler so {@link DeviceSlotReconciler}'s {@code @Scheduled} counter-repair job
 * runs (BE §11.1). {@code @EnableScheduling} is app-wide but idempotent, so it is harmless if
 * another package enables it too.
 */
@Configuration
@EnableScheduling
public class DevicesConfig {}
