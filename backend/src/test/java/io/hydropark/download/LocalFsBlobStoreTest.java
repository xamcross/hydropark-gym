package io.hydropark.download;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.time.Instant;
import org.junit.jupiter.api.Test;

/**
 * The dev signer's contract (P1-19.1): a token that is deterministic, verifiable, expiring, and
 * bound to all of {@code objectKey|userScope|expiry} so none can be swapped. Plain JUnit, no Spring,
 * no Docker.
 */
class LocalFsBlobStoreTest {

  private static final String KEY = "skills/cooking/1.2.0/package.hpskill";
  private static final String SCOPE = "user-1";

  private final BlobStoreProperties props = props();
  private final LocalFsBlobStore store = new LocalFsBlobStore(props);

  private static BlobStoreProperties props() {
    BlobStoreProperties p = new BlobStoreProperties();
    p.setHmacSecret("test-secret");
    p.setBaseUrl("https://cdn.example/blobs");
    return p;
  }

  @Test
  void signatureIsDeterministicAndVerifies() {
    long exp = Instant.now().plusSeconds(300).getEpochSecond();

    String sig1 = store.sign(KEY, SCOPE, exp);
    String sig2 = store.sign(KEY, SCOPE, exp);

    assertThat(sig1).isEqualTo(sig2); // deterministic over identical inputs
    assertThat(store.verify(KEY, SCOPE, exp, sig1, Instant.now())).isTrue();
  }

  @Test
  void rejectsAnExpiredToken() {
    long exp = Instant.now().minusSeconds(10).getEpochSecond();
    String sig = store.sign(KEY, SCOPE, exp);

    assertThat(store.verify(KEY, SCOPE, exp, sig, Instant.now())).isFalse();
  }

  @Test
  void rejectsTamperedSignatureScopeKeyOrExtendedExpiry() {
    long exp = Instant.now().plusSeconds(300).getEpochSecond();
    String sig = store.sign(KEY, SCOPE, exp);
    Instant now = Instant.now();

    assertThat(store.verify(KEY, SCOPE, exp, sig + "x", now)).as("tampered signature").isFalse();
    assertThat(store.verify(KEY, "attacker", exp, sig, now)).as("lifted to another user").isFalse();
    assertThat(store.verify("skills/other/1.0.0/package.hpskill", SCOPE, exp, sig, now))
        .as("swapped object key")
        .isFalse();
    assertThat(store.verify(KEY, SCOPE, exp + 3600, sig, now)).as("extended TTL").isFalse();
    assertThat(store.verify(KEY, SCOPE, exp, null, now)).as("missing signature").isFalse();
  }

  @Test
  void signedUrlEmbedsScopeExpiryAndAVerifiableSignature() {
    SignedUrl signed = store.signedUrl(KEY, SCOPE, Duration.ofMinutes(5));

    assertThat(signed.url()).startsWith("https://cdn.example/blobs/" + KEY + "?");
    assertThat(signed.url()).contains("scope=" + SCOPE).contains("&exp=").contains("&sig=");
    assertThat(signed.expiresAt()).isAfter(Instant.now());

    // The token carried in the URL is exactly the one verify() accepts for that expiry.
    long exp = signed.expiresAt().getEpochSecond();
    String expectedSig = store.sign(KEY, SCOPE, exp);
    assertThat(signed.url()).contains("&sig=" + expectedSig);
    assertThat(store.verify(KEY, SCOPE, exp, expectedSig, Instant.now())).isTrue();
  }
}
