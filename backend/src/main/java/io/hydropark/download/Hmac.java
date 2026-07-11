package io.hydropark.download;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.Base64;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * HMAC-SHA256 over a message, base64url-encoded (no padding). Shared by {@link LocalFsBlobStore}'s
 * URL signing and {@link DownloadService}'s buyer-watermark token so both derive from one keyed
 * primitive rather than re-implementing the MAC at each call site.
 */
final class Hmac {

  private static final String ALG = "HmacSHA256";

  private Hmac() {}

  static String sha256Base64Url(String secret, String message) {
    try {
      Mac mac = Mac.getInstance(ALG);
      mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), ALG));
      byte[] raw = mac.doFinal(message.getBytes(StandardCharsets.UTF_8));
      return Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
    } catch (GeneralSecurityException e) {
      // HmacSHA256 is a mandatory JCA algorithm; its absence is an environment fault, not input.
      throw new IllegalStateException("HMAC-SHA256 unavailable", e);
    }
  }
}
