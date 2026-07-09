package io.hydropark.common;

import java.util.Map;

/**
 * Appendix A error envelope:
 * {@code { "error": { "code": "slot_limit_reached", "message": "...", "details": {} } }}
 */
public record ApiError(Body error) {

  public record Body(String code, String message, Map<String, Object> details) {}

  public static ApiError of(ErrorCode code, String message, Map<String, Object> details) {
    return new ApiError(new Body(code.code(), message, details == null ? Map.of() : details));
  }
}
