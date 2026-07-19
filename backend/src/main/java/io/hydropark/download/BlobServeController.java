package io.hydropark.download;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Dev-only stand-in for a CDN edge (P1-19). {@link LocalFsBlobStore#signedUrl} mints URLs shaped
 * {@code {base-url}/{objectKey}?scope=...&exp=...&sig=...}; a real deployment serves that shape
 * straight from Cloudflare R2 / a CDN and the api zone never sees the bytes. This controller
 * exists purely so the signed-URL contract is exercisable end-to-end on a laptop: it re-verifies
 * the exact same HMAC {@link LocalFsBlobStore#verify} checks at mint time (constant-time compare,
 * hard expiry) and, only once that passes, streams the file straight off {@code local-root}.
 *
 * <p>Active only when {@code hydropark.blobstore.provider=local}, mirroring {@link
 * LocalFsBlobStore}'s own condition - there is nothing on disk for it to serve when R2 is
 * selected, and no {@link LocalFsBlobStore} bean would exist to inject.
 *
 * <p>A tampered or expired signature is a flat 403. A syntactically valid signature over a key
 * that was never {@link LocalFsBlobStore#store stored} - or that turns out, after resolving
 * against the root, to have tried to climb outside it - is a 404: the caller learns nothing about
 * *why* nothing came back.
 */
@RestController
@ConditionalOnProperty(
    prefix = "hydropark.blobstore",
    name = "provider",
    havingValue = "local",
    matchIfMissing = true)
public class BlobServeController {

  private final LocalFsBlobStore store;

  public BlobServeController(LocalFsBlobStore store) {
    this.store = store;
  }

  @GetMapping("/blobs/{*path}")
  public ResponseEntity<Resource> serve(
      @PathVariable String path,
      @RequestParam String scope,
      @RequestParam long exp,
      @RequestParam String sig) {
    String objectKey = path.startsWith("/") ? path.substring(1) : path;

    if (!store.verify(objectKey, scope, exp, sig, Instant.now())) {
      return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
    }

    Path resolved;
    try {
      resolved = store.resolve(objectKey);
    } catch (IllegalArgumentException e) {
      // A path-traversal attempt looks exactly like "not found" to the caller.
      return ResponseEntity.status(HttpStatus.NOT_FOUND).build();
    }

    long length;
    try {
      if (!Files.isRegularFile(resolved)) {
        return ResponseEntity.status(HttpStatus.NOT_FOUND).build();
      }
      length = Files.size(resolved);
    } catch (IOException e) {
      return ResponseEntity.status(HttpStatus.NOT_FOUND).build();
    }

    return ResponseEntity.ok()
        .contentType(MediaType.APPLICATION_OCTET_STREAM)
        .contentLength(length)
        .body(new FileSystemResource(resolved));
  }
}
