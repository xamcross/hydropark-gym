package io.hydropark.commerce;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * Enables {@code @Scheduled} only in the worker zone, so the api/issuer zones never run the
 * settlement poller (they hold no MoR secret and must not verify webhooks - §2, N3).
 */
@Configuration
@EnableScheduling
@ConditionalOnProperty(name = "hydropark.worker.enabled", havingValue = "true", matchIfMissing = true)
public class WorkerSchedulingConfig {}
