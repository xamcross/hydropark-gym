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

  /**
   * Persists {@code content} under {@code objectKey} so a URL later minted by {@link #signedUrl}
   * for the same key has real bytes to serve. Added because {@link LocalFsBlobStore} previously
   * only ever minted URLs - nothing wrote the bytes a client would go on to fetch, so the local
   * dev download loop dead-ended right after signing. The publish path (P1-20) calls this to land
   * a {@code .hpskill} package or model file under {@code local-root}.
   *
   * <p>A real object-store adapter would instead hand the publisher a presigned PUT and never see
   * the bytes itself, so {@link R2BlobStore} has no real implementation of this yet.
   */
  void store(String objectKey, byte[] content);
}
