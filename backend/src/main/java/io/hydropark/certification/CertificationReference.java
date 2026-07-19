package io.hydropark.certification;

/**
 * The reference environment a skill version is certified AGAINST (P1-20.5, SPEC §8.6): the platform's
 * reference base-model id and the widget-library version. A skill's certification is only valid while
 * both still match the live platform reference; when either changes, every version certified against
 * the old reference must be re-certified (the {@link RecertificationTrigger}).
 *
 * @param baseModelId reference base-model identifier (e.g. {@code "qwen2.5-3b-instruct"})
 * @param widgetLibraryVersion widget-library version the UI pack was certified against (e.g. {@code
 *     "1.0"})
 */
public record CertificationReference(String baseModelId, String widgetLibraryVersion) {

  public static CertificationReference of(String baseModelId, String widgetLibraryVersion) {
    return new CertificationReference(baseModelId, widgetLibraryVersion);
  }
}
