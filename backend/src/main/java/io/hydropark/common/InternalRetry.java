package io.hydropark.common;

import java.io.IOException;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.client.RestClientException;

/**
 * Retries a zone-crossing call when the transport fails.
 *
 * <p>The issuer scales to zero. Waking a suspended Fly machine through the proxy takes 9-11 seconds
 * (measured), and the request that triggers the wake does not survive it: the connection is accepted
 * and then closed, surfacing as {@code SocketException: Unexpected end of file from server} while
 * Spring is extracting the response body. Crucially that happens <em>after</em> the request has been
 * executed, so a {@code ClientHttpRequestInterceptor} - which only wraps the execute call - never
 * sees it. The retry has to wrap the whole call, response extraction included.
 *
 * <p><b>Why retrying is safe.</b> Both zone-crossing operations are idempotent by construction, not
 * by convention:
 *
 * <ul>
 *   <li>License issuance is guarded by the partial-unique index on
 *       {@code licenses (user_id, skill_id, device_id) WHERE status='active'}: a repeated call
 *       returns the existing token rather than minting a second.
 *   <li>The wallet spend carries an {@code Idempotency-Key} enforced by a unique index on
 *       {@code wallet_transactions.idempotency_key}: a repeated debit cannot apply twice.
 * </ul>
 *
 * A future internal endpoint that is not idempotent must not use this helper.
 *
 * <p>Only transport failures retry. An {@link ApiException} - the issuer deciding "not entitled" -
 * is an answer, not a fault, and propagates on the first attempt. An HTTP error that has already
 * been translated is likewise never retried.
 */
public final class InternalRetry {

  private static final Logger log = LoggerFactory.getLogger(InternalRetry.class);
  private static final int MAX_ATTEMPTS = 3;

  private InternalRetry() {}

  public static <T> T call(String zone, Supplier<T> call) {
    RestClientException last = null;
    for (int attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return call.get();
      } catch (RestClientException e) {
        if (!isTransportFailure(e)) {
          throw e; // a response we understood; not something a retry can fix
        }
        last = e;
        if (attempt < MAX_ATTEMPTS) {
          log.warn(
              "internal call to {} failed on attempt {}/{} ({}); retrying - the zone may be resuming"
                  + " from suspend",
              zone,
              attempt,
              MAX_ATTEMPTS,
              rootCause(e).getClass().getSimpleName());
          sleep(1000L * attempt);
        }
      }
    }
    log.error("internal call to {} failed after {} attempts", zone, MAX_ATTEMPTS, last);
    throw new ApiException(
        ErrorCode.INTERNAL_ERROR, zone + " unreachable after " + MAX_ATTEMPTS + " attempts");
  }

  private static boolean isTransportFailure(Throwable t) {
    for (Throwable c = t; c != null; c = c.getCause()) {
      if (c instanceof IOException) {
        return true;
      }
      if (c.getCause() == c) {
        break;
      }
    }
    return false;
  }

  private static Throwable rootCause(Throwable t) {
    Throwable c = t;
    while (c.getCause() != null && c.getCause() != c) {
      c = c.getCause();
    }
    return c;
  }

  private static void sleep(long millis) {
    try {
      Thread.sleep(millis);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new ApiException(ErrorCode.INTERNAL_ERROR, "interrupted while retrying internal call");
    }
  }
}
