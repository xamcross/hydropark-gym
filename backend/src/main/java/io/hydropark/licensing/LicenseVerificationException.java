package io.hydropark.licensing;

/**
 * Thrown when a license token fails verification: malformed structure, an untrusted or unknown
 * {@code kid}, a bad signature, or a failed field check. The offline client raises the analogous
 * error; on the server this signals an audit/forgery concern rather than an ordinary 4xx.
 */
public class LicenseVerificationException extends RuntimeException {

  public LicenseVerificationException(String message) {
    super(message);
  }

  public LicenseVerificationException(String message, Throwable cause) {
    super(message, cause);
  }
}
