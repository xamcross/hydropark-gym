package io.hydropark.auth.support;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.Base64;

/**
 * Opaque-secret generation and hashing for the auth package. Refresh tokens, verification/reset
 * tokens, recovery codes, and step-up secrets are all high-entropy random values; only their SHA-256
 * hash is ever persisted (BACKEND-DESIGN §3.6, §8).
 */
public final class Tokens {

  private static final SecureRandom RANDOM = new SecureRandom();
  private static final Base64.Encoder B64URL = Base64.getUrlEncoder().withoutPadding();

  private Tokens() {}

  /** Opaque 256-bit random secret, base64url. Used for refresh, verify, and reset tokens. */
  public static String opaque() {
    return random(32);
  }

  /** 160-bit random code, base64url. Used for recovery codes and emailed step-up codes. */
  public static String code() {
    return random(20);
  }

  private static String random(int bytes) {
    byte[] b = new byte[bytes];
    RANDOM.nextBytes(b);
    return B64URL.encodeToString(b);
  }

  /** SHA-256, base64url (no padding). Deterministic, so a presented secret can be matched by hash. */
  public static String sha256(String value) {
    try {
      byte[] digest =
          MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
      return B64URL.encodeToString(digest);
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException("SHA-256 unavailable", e);
    }
  }

  /** Constant-time comparison of two already-hashed values. */
  public static boolean constantTimeEquals(String a, String b) {
    if (a == null || b == null) {
      return false;
    }
    return MessageDigest.isEqual(
        a.getBytes(StandardCharsets.UTF_8), b.getBytes(StandardCharsets.UTF_8));
  }
}
