package io.hydropark.certification;

/** Why a skill version needs re-certification (P1-20.5). Carries a stable wire code for the record. */
public enum RecertificationReason {
  BASE_MODEL_CHANGED("base_model_changed"),
  WIDGET_LIBRARY_CHANGED("widget_library_changed"),
  BOTH_CHANGED("both_changed");

  private final String wire;

  RecertificationReason(String wire) {
    this.wire = wire;
  }

  public String wire() {
    return wire;
  }
}
