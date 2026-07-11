package io.hydropark.download;

import java.time.Duration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/**
 * Cloudflare R2 {@link BlobStore} - STUB. Active only when {@code hydropark.blobstore.provider=r2};
 * the {@code local} adapter is the default everywhere else, so nothing wires this today.
 *
 * <p>Deliberately not implemented: a real adapter would presign a GET against the R2 S3-compatible
 * endpoint (AWS SigV4, short expiry), which needs an access key id / secret and the bucket + account
 * host. Rather than ship a half-built client, this fails loudly if selected.
 */
@Component
@ConditionalOnProperty(prefix = "hydropark.blobstore", name = "provider", havingValue = "r2")
public class R2BlobStore implements BlobStore {

  public R2BlobStore(BlobStoreProperties props) {
    // Creds (access key / secret / account host / bucket) would bind from props here.
  }

  @Override
  public SignedUrl signedUrl(String objectKey, String userScope, Duration ttl) {
    // TODO gated on Cloudflare R2 creds (P1-19): SigV4-presign a GET against the R2 S3 endpoint.
    throw new UnsupportedOperationException(
        "R2BlobStore is a stub - gated on Cloudflare R2 creds (P1-19). "
            + "Use hydropark.blobstore.provider=local for dev/test.");
  }
}
