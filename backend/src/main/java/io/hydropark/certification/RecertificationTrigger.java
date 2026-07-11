package io.hydropark.certification;

import java.util.List;
import java.util.Objects;
import java.util.Optional;

/**
 * P1-20.5: marks {@code skill_versions} as needing re-certification when the platform's reference
 * base-model id or widget-library version changes (SPEC §8.6). A certification is a statement about a
 * skill's behaviour ON a specific base model and widget library; the moment either reference moves,
 * every version certified against the OLD reference is stale and must be re-run through the gate
 * before it can keep its certified status.
 *
 * <p>Pure logic: it reads the certified fleet and marks stale versions through a
 * {@link RecertificationLedgerPort}, never touching Mongo or the catalog package directly, so it is
 * fully unit-testable with an in-memory ledger. Deliberately NOT a Spring {@code @Service}: the
 * ledger adapter is owned by the {@code skill_versions} package and is wired up there (or in config)
 * when the recertification job is scheduled — constructing this trigger requires only that port.
 */
public final class RecertificationTrigger {

  private final RecertificationLedgerPort ledger;

  public RecertificationTrigger(RecertificationLedgerPort ledger) {
    this.ledger = ledger;
  }

  /**
   * Sweep the certified fleet against the current platform reference, marking every version whose
   * certified reference no longer matches. Returns which versions were marked and why.
   */
  public RecertificationSweep sweep(CertificationReference current) {
    List<CertifiedVersion> certified = ledger.listCertified();
    RecertificationSweep.Builder result = new RecertificationSweep.Builder();
    for (CertifiedVersion cv : certified) {
      Optional<RecertificationReason> reason = reasonFor(cv.certifiedAgainst(), current);
      if (reason.isPresent()) {
        ledger.markNeedsRecertification(cv.skillVersionId(), reason.get());
        result.add(cv.skillVersionId(), reason.get());
      }
    }
    return result.build();
  }

  /**
   * The pure decision: why (if at all) a version certified against {@code certifiedAgainst} needs
   * re-certification given the {@code current} reference. Empty when both references still match.
   */
  public static Optional<RecertificationReason> reasonFor(
      CertificationReference certifiedAgainst, CertificationReference current) {
    boolean baseChanged = !Objects.equals(certifiedAgainst.baseModelId(), current.baseModelId());
    boolean widgetChanged =
        !Objects.equals(
            certifiedAgainst.widgetLibraryVersion(), current.widgetLibraryVersion());
    if (baseChanged && widgetChanged) {
      return Optional.of(RecertificationReason.BOTH_CHANGED);
    }
    if (baseChanged) {
      return Optional.of(RecertificationReason.BASE_MODEL_CHANGED);
    }
    if (widgetChanged) {
      return Optional.of(RecertificationReason.WIDGET_LIBRARY_CHANGED);
    }
    return Optional.empty();
  }
}
