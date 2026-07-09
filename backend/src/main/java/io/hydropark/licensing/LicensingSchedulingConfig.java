package io.hydropark.licensing;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * Enables Spring's scheduler in the <b>issuer zone</b> so {@link RollingKeyReissuanceJob}'s
 * {@code @Scheduled} no-stranding re-issue can run (BACKEND-DESIGN §6.3 B7). Gated on
 * {@code hydropark.issuer.enabled=true} so the api/worker zones - which hold no signing key - never
 * stand up an issuer-only schedule.
 *
 * <p>{@code @EnableScheduling} is app-wide and idempotent, so declaring it here in addition to any
 * other zone's copy is harmless; doing so keeps the issuer's schedule self-contained rather than
 * silently depending on another package happening to enable scheduling.
 */
@Configuration
@EnableScheduling
@ConditionalOnProperty(name = "hydropark.issuer.enabled", havingValue = "true")
public class LicensingSchedulingConfig {}
