package io.hydropark.continuity;

/**
 * Thrown when a continuity bundle fails verification (P1-23.2): a manifest whose counts or id lists
 * disagree with the body, a package ref missing its integrity anchor, a license bound to the wrong
 * user or an unlisted id, or a license whose JWS signature does not verify. Carries a stable {@link
 * #code()} so the install path can branch on <em>why</em> a bundle was rejected. The continuity
 * analogue of {@code licensing.LicenseVerificationException} / {@code
 * packaging.PackageSignatureException}.
 */
public class ContinuityBundleException extends RuntimeException {

  private final String code;

  public ContinuityBundleException(String code, String message) {
    super(message);
    this.code = code;
  }

  public ContinuityBundleException(String code, String message, Throwable cause) {
    super(message, cause);
    this.code = code;
  }

  public String code() {
    return code;
  }
}
