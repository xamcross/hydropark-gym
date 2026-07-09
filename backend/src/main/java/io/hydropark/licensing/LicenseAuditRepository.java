package io.hydropark.licensing;

import org.springframework.data.mongodb.repository.MongoRepository;

/**
 * Append-only writes for {@code license_audit}. The rate-limit counts are computed with
 * {@code MongoTemplate} in {@link IssuanceRateLimiter} rather than here, because they need a
 * time-window criterion the derived-query vocabulary can't express cleanly.
 */
public interface LicenseAuditRepository extends MongoRepository<LicenseAudit, String> {}
