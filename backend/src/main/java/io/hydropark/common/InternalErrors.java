package io.hydropark.common;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import org.springframework.http.client.ClientHttpResponse;

/**
 * Translates an error response from an internal zone (issuer, settlement worker) back into the
 * {@link ApiException} the calling zone would have thrown had the work run in-process.
 *
 * <p>Without this, a {@code RestClient} turns the issuer's deliberate {@code 403 not_entitled} into
 * an {@code HttpClientErrorException}, which falls through to the generic handler and reaches the
 * user as {@code 500 internal_error}. The security decision was correct and the client is told
 * nothing useful - the worst combination, because the endpoint looks broken rather than protective.
 *
 * <p>This lives in {@code common} because both remote ports need it, and two independent copies of a
 * cross-zone contract is precisely how the step-up action strings drifted.
 */
public final class InternalErrors {

  private InternalErrors() {}

  /**
   * Reads an {@link ApiError} envelope off the response and rethrows it. Falls back to
   * {@code INTERNAL_ERROR} when the body is absent or unparseable.
   *
   * @param zone name of the zone that answered, used only in the fallback message
   */
  public static void rethrow(ClientHttpResponse response, ObjectMapper mapper, String zone)
      throws IOException {
    ApiError parsed = null;
    try {
      parsed = mapper.readValue(response.getBody(), ApiError.class);
    } catch (Exception ignored) {
      // An internal zone that did not answer with our envelope is itself a fault; fall through.
    }
    if (parsed != null && parsed.error() != null) {
      throw new ApiException(
          codeFor(parsed.error().code()),
          parsed.error().message(),
          parsed.error().details());
    }
    throw new ApiException(ErrorCode.INTERNAL_ERROR, zone + " error");
  }

  private static ErrorCode codeFor(String wire) {
    for (ErrorCode c : ErrorCode.values()) {
      if (c.code().equals(wire)) {
        return c;
      }
    }
    return ErrorCode.INTERNAL_ERROR;
  }
}
