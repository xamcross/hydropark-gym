package io.hydropark.packaging;

/**
 * Thrown when a package signature fails verification: missing signature/kid, an unknown or rolled-off
 * package {@code signing_key_id}, an unsupported algorithm prefix, malformed base64, or a signature
 * that does not match the manifest. Carries a stable {@link #code()} so the registry submission path
 * can turn a rejection into a machine-branchable {@code Finding} rather than an opaque 500. The
 * package analogue of {@code licensing.LicenseVerificationException}.
 */
public class PackageSignatureException extends RuntimeException {

  private final String code;

  public PackageSignatureException(String code, String message) {
    super(message);
    this.code = code;
  }

  public PackageSignatureException(String code, String message, Throwable cause) {
    super(message, cause);
    this.code = code;
  }

  public String code() {
    return code;
  }
}
