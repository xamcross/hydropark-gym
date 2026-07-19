package io.hydropark.certification;

/**
 * A currently-certified skill version and the {@link CertificationReference} it was certified against
 * (P1-20.5). Supplied to the {@link RecertificationTrigger} by the {@link RecertificationLedgerPort};
 * the {@code skillVersionId} is the {@code skill_versions._id} the trigger asks the ledger to mark.
 *
 * @param skillVersionId {@code skill_versions._id} (UUIDv7)
 * @param certifiedAgainst the reference environment this version's certification was issued against
 */
public record CertifiedVersion(String skillVersionId, CertificationReference certifiedAgainst) {}
