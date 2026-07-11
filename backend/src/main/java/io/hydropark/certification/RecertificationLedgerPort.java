package io.hydropark.certification;

import java.util.List;

/**
 * The persistence seam for the {@link RecertificationTrigger} (P1-20.5). Keeps this package
 * decoupled from {@code io.hydropark.catalog} and from Mongo: the trigger reads the certified fleet
 * and marks stale versions through this interface only, so it stays pure-logic and unit-testable.
 *
 * <p>The production adapter lives with the {@code skill_versions} owner (the catalog package) and
 * implements {@link #markNeedsRecertification} by flipping the version's certification status /
 * setting a {@code needs_recertification} flag; this package intentionally defines only the contract.
 */
public interface RecertificationLedgerPort {

  /** Every skill version currently marked certified, with the reference it was certified against. */
  List<CertifiedVersion> listCertified();

  /** Mark one skill version as needing re-certification, recording why. Idempotent per version. */
  void markNeedsRecertification(String skillVersionId, RecertificationReason reason);
}
