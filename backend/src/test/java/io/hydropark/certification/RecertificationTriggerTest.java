package io.hydropark.certification;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * P1-20.5: the recertification trigger. Pure-logic tests over an in-memory ledger — no Mongo, no
 * Spring, no Docker. Covers each reason (base-model / widget-library / both), the no-op case, a mixed
 * fleet where only stale versions are marked, and the pure {@code reasonFor} decision.
 */
class RecertificationTriggerTest {

  private static final CertificationReference REF = CertificationReference.of("qwen2.5-3b", "1.0");

  @Test
  void baseModelChangeMarksTheAffectedVersion() {
    FakeLedger ledger = new FakeLedger(List.of(new CertifiedVersion("v1", REF)));
    RecertificationSweep sweep =
        new RecertificationTrigger(ledger).sweep(CertificationReference.of("qwen3-4b", "1.0"));

    assertThat(ledger.marks).containsEntry("v1", RecertificationReason.BASE_MODEL_CHANGED);
    assertThat(sweep.count()).isEqualTo(1);
    assertThat(sweep.marked().get(0).skillVersionId()).isEqualTo("v1");
  }

  @Test
  void widgetLibraryChangeMarksTheAffectedVersion() {
    FakeLedger ledger = new FakeLedger(List.of(new CertifiedVersion("v1", REF)));
    new RecertificationTrigger(ledger).sweep(CertificationReference.of("qwen2.5-3b", "1.1"));

    assertThat(ledger.marks).containsEntry("v1", RecertificationReason.WIDGET_LIBRARY_CHANGED);
  }

  @Test
  void bothChangedIsReportedAsBoth() {
    FakeLedger ledger = new FakeLedger(List.of(new CertifiedVersion("v1", REF)));
    new RecertificationTrigger(ledger).sweep(CertificationReference.of("qwen3-4b", "2.0"));

    assertThat(ledger.marks).containsEntry("v1", RecertificationReason.BOTH_CHANGED);
  }

  @Test
  void anUnchangedReferenceMarksNothing() {
    FakeLedger ledger = new FakeLedger(List.of(new CertifiedVersion("v1", REF)));
    RecertificationSweep sweep = new RecertificationTrigger(ledger).sweep(REF);

    assertThat(ledger.marks).isEmpty();
    assertThat(sweep.isEmpty()).isTrue();
  }

  @Test
  void onlyStaleVersionsInAMixedFleetAreMarked() {
    CertificationReference current = CertificationReference.of("qwen3-4b", "1.0");
    FakeLedger ledger =
        new FakeLedger(
            List.of(
                new CertifiedVersion("v1", REF), // stale: base model changed
                new CertifiedVersion("v2", current), // already on the current reference
                new CertifiedVersion("v3", REF))); // stale: base model changed

    RecertificationSweep sweep = new RecertificationTrigger(ledger).sweep(current);

    assertThat(ledger.marks).containsOnlyKeys("v1", "v3");
    assertThat(ledger.marks.get("v1")).isEqualTo(RecertificationReason.BASE_MODEL_CHANGED);
    assertThat(sweep.count()).isEqualTo(2);
  }

  @Test
  void reasonForIsAPureDecision() {
    assertThat(RecertificationTrigger.reasonFor(REF, REF)).isEmpty();
    assertThat(RecertificationTrigger.reasonFor(REF, CertificationReference.of("other", "1.0")))
        .contains(RecertificationReason.BASE_MODEL_CHANGED);
    assertThat(RecertificationTrigger.reasonFor(REF, CertificationReference.of("qwen2.5-3b", "9.9")))
        .contains(RecertificationReason.WIDGET_LIBRARY_CHANGED);
    assertThat(RecertificationTrigger.reasonFor(REF, CertificationReference.of("other", "9.9")))
        .contains(RecertificationReason.BOTH_CHANGED);
  }

  /** In-memory {@link RecertificationLedgerPort} capturing what the trigger marked. */
  private static final class FakeLedger implements RecertificationLedgerPort {
    private final List<CertifiedVersion> certified;
    private final Map<String, RecertificationReason> marks = new LinkedHashMap<>();

    FakeLedger(List<CertifiedVersion> certified) {
      this.certified = certified;
    }

    @Override
    public List<CertifiedVersion> listCertified() {
      return certified;
    }

    @Override
    public void markNeedsRecertification(String skillVersionId, RecertificationReason reason) {
      marks.put(skillVersionId, reason);
    }
  }
}
