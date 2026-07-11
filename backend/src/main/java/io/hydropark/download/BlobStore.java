package io.hydropark.download;

import java.time.Duration;

/**
 * Object-store facade for content delivery (P1-19). Issues a short-TTL signed URL for one object
 * key without ever streaming bytes through the api zone - the client fetches the object straight
 * from the CDN/bucket, and the signature is what bounds who may do so and for how long.
 *
 * <p>Two implementations exist: {@link LocalFsBlobStore} (dev default, HMAC-signed and locally
 * verifiable) and {@link R2BlobStore} (a stub until Cloudflare R2 creds land). Exactly one is active,
 * selected by {@code hydropark.blobstore.provider}.
 */
public interface BlobStore {

  /**
   * Mints a signed URL for {@code objectKey}, valid for {@code ttl}.
   *
   * @param userScope the principal the URL is bound to. A per-user value makes the URL
   *     non-transferable (paid {@code .hpskill} downloads); a shared constant (e.g. {@code
   *     "public"}) keeps it cacheable across users (the free base-model GGUF, P1-19.3).
   */
  SignedUrl signedUrl(String objectKey, String userScope, Duration ttl);
}
