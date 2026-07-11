package io.hydropark.download;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/**
 * Dev/default {@link BlobStore}: mints a URL carrying an HMAC over {@code objectKey|userScope|expiry}
 * plus the expiry itself, so the token is deterministic (same inputs -> same signature) and
 * independently verifiable ({@link #verify}) without any external service. It stands in for a real
 * presigner (S3/R2) so the whole download flow - entitlement, watermark, egress - is exercisable
 * end-to-end on a laptop.
 *
 * <p>The MAC binds all three of key, scope and expiry, so a client cannot swap the object it is
 * entitled to, lift another user's URL, or extend its own TTL without invalidating the signature.
 * {@link #verify} compares in constant time and treats {@code now > expiry} as a hard reject.
 */
@Component
@ConditionalOnProperty(prefix = "hydropark.blobstore", name = "provider", havingValue = "local",
    matchIfMissing = true)
public class LocalFsBlobStore implements BlobStore {

  private final BlobStoreProperties props;

  public LocalFsBlobStore(BlobStoreProperties props) {
    this.props = props;
  }

  @Override
  public SignedUrl signedUrl(String objectKey, String userScope, Duration ttl) {
    Instant expiresAt = Instant.now().plus(ttl);
    long exp = expiresAt.getEpochSecond();
    String sig = sign(objectKey, userScope, exp);
    String url =
        props.getBaseUrl()
            + "/"
            + objectKey
            + "?scope="
            + urlEncode(userScope)
            + "&exp="
            + exp
            + "&sig="
            + sig;
    return new SignedUrl(url, expiresAt);
  }

  /** The token an issued URL carries: {@code HMAC(objectKey | userScope | expiry)}. */
  String sign(String objectKey, String userScope, long expiryEpochSeconds) {
    return Hmac.sha256Base64Url(
        props.getHmacSecret(), objectKey + "|" + userScope + "|" + expiryEpochSeconds);
  }

  /**
   * Recomputes the MAC and checks it in constant time, rejecting an expired or tampered token. A CDN
   * edge / bucket policy would run this same check; exposing it here also lets a test assert the
   * signature holds and that a swapped key, scope, expiry, or signature is refused.
   */
  boolean verify(
      String objectKey, String userScope, long expiryEpochSeconds, String sig, Instant now) {
    if (now.getEpochSecond() > expiryEpochSeconds) {
      return false; // expired - refuse before spending a MAC comparison
    }
    if (sig == null) {
      return false;
    }
    String expected = sign(objectKey, userScope, expiryEpochSeconds);
    return MessageDigest.isEqual(
        expected.getBytes(StandardCharsets.UTF_8), sig.getBytes(StandardCharsets.UTF_8));
  }

  private static String urlEncode(String s) {
    return URLEncoder.encode(s, StandardCharsets.UTF_8);
  }
}
