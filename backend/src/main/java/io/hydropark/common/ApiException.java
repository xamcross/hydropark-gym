package io.hydropark.common;

import java.util.Map;

/** Domain failure carrying a wire error code. Rendered by {@link GlobalExceptionHandler}. */
public class ApiException extends RuntimeException {

  private final ErrorCode errorCode;
  private final transient Map<String, Object> details;

  public ApiException(ErrorCode errorCode, String message) {
    this(errorCode, message, Map.of());
  }

  public ApiException(ErrorCode errorCode, String message, Map<String, Object> details) {
    super(message);
    this.errorCode = errorCode;
    this.details = details == null ? Map.of() : details;
  }

  public ErrorCode errorCode() {
    return errorCode;
  }

  public Map<String, Object> details() {
    return details;
  }

  public static ApiException notFound(String what) {
    return new ApiException(ErrorCode.NOT_FOUND, what + " not found");
  }

  /**
   * {@code skillId} may legitimately be null when a malformed internal request reaches the Issuer.
   * {@link Map#of} rejects null values, so building the detail map naively made the exception
   * constructor itself throw - converting a clean 403 into an opaque 500 and hiding the real cause.
   */
  public static ApiException notEntitled(String skillId) {
    Map<String, Object> details = skillId == null ? Map.of() : Map.of("skill_id", skillId);
    return new ApiException(ErrorCode.NOT_ENTITLED, "no active entitlement for " + skillId, details);
  }

  public static ApiException stepUpRequired(String reason) {
    return new ApiException(ErrorCode.STEP_UP_REQUIRED, reason);
  }

  public static ApiException validation(String message) {
    return new ApiException(ErrorCode.VALIDATION_ERROR, message);
  }
}
