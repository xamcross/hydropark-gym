package io.hydropark.download;

import io.hydropark.port.Ports;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
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
 *
 * <p>{@link #store} persists real bytes under {@link BlobStoreProperties#getLocalRoot()}, and
 * {@link BlobServeController} serves them back for a URL that passes {@link #verify} - together
 * these make the whole signed-download contract exercisable without any external service.
 *
 * <p>Also implements {@link Ports.BlobStorePort} (the download package's port contribution -
 * {@code io.hydropark.port.Ports}) so a cross-package publisher (e.g. {@code packaging}'s dev
 * catalog publisher) can depend on the port rather than importing this concrete download-package
 * class. {@link #store} already has the exact port signature - no new method needed.
 */
@Component
@ConditionalOnProperty(prefix = "hydropark.blobstore", name = "provider", havingValue = "local",
    matchIfMissing = true)
public class LocalFsBlobStore implements BlobStore, Ports.BlobStorePort {

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

  /** {@inheritDoc} Writes {@code content} to {@code local-root/objectKey}, creating parent dirs. */
  @Override
  public void store(String objectKey, byte[] content) {
    Path target = resolve(objectKey);
    try {
      if (target.getParent() != null) {
        Files.createDirectories(target.getParent());
      }
      Files.write(target, content);
    } catch (IOException e) {
      throw new UncheckedIOException("failed to persist blob " + objectKey, e);
    }
  }

  /**
   * Resolves {@code objectKey} against {@code local-root} and refuses to leave it.
   *
   * <p>A leading {@code /} or {@code \} is stripped first, so a Unix-style "absolute" key such as
   * {@code /etc/passwd} is silently relativized to {@code etc/passwd} rather than rejected
   * outright - containment for it (and for any relative key laced with {@code ..}, either slash
   * style) comes entirely from the final {@code startsWith(root)} check after normalization. Only
   * a key that is still absolute <em>after</em> that stripping - e.g. a drive-qualified {@code
   * C:/Windows/win.ini} on Windows - throws immediately, before normalization even runs.
   *
   * <p>Either way, anything that would climb above the root throws rather than silently reading
   * or writing outside the dev blobstore directory. {@link BlobServeController} reuses this exact
   * guard for every inbound {@code GET /blobs/...} request, so the two never disagree about what
   * counts as an escape.
   */
  Path resolve(String objectKey) {
    if (objectKey == null || objectKey.isBlank()) {
      throw new IllegalArgumentException("empty object key");
    }
    String cleaned = objectKey.replace('\\', '/');
    while (cleaned.startsWith("/")) {
      cleaned = cleaned.substring(1);
    }
    Path relative = Paths.get(cleaned);
    if (relative.isAbsolute()) {
      throw new IllegalArgumentException("object key must be relative: " + objectKey);
    }
    Path root = Paths.get(props.getLocalRoot()).toAbsolutePath().normalize();
    Path candidate = root.resolve(relative).normalize();
    if (!candidate.startsWith(root)) {
      throw new IllegalArgumentException("object key escapes the blobstore root: " + objectKey);
    }
    return candidate;
  }
}
