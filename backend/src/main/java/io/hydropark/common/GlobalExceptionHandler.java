package io.hydropark.common;

import com.mongodb.MongoWriteException;
import com.mongodb.ErrorCategory;
import java.util.HashMap;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@RestControllerAdvice
public class GlobalExceptionHandler {

  private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

  @ExceptionHandler(ApiException.class)
  public ResponseEntity<ApiError> handleApi(ApiException e) {
    // Domain failures are expected control flow; do not log them at error level.
    if (log.isDebugEnabled()) {
      log.debug("api error {}: {}", e.errorCode().code(), e.getMessage());
    }
    return ResponseEntity.status(e.errorCode().status())
        .body(ApiError.of(e.errorCode(), e.getMessage(), e.details()));
  }

  @ExceptionHandler(MethodArgumentNotValidException.class)
  public ResponseEntity<ApiError> handleBeanValidation(MethodArgumentNotValidException e) {
    Map<String, Object> fields = new HashMap<>();
    e.getBindingResult()
        .getFieldErrors()
        .forEach(fe -> fields.put(fe.getField(), fe.getDefaultMessage()));
    return ResponseEntity.status(ErrorCode.VALIDATION_ERROR.status())
        .body(ApiError.of(ErrorCode.VALIDATION_ERROR, "request validation failed", fields));
  }

  /**
   * Insert-first dedupe (§3.3 webhook_events, §3.5): a duplicate-key error is the *intended*
   * short-circuit, not a bug. Callers that rely on it catch DuplicateKeyException themselves; if one
   * escapes to here it is still a conflict, never a 500.
   */
  @ExceptionHandler({DuplicateKeyException.class, MongoWriteException.class})
  public ResponseEntity<ApiError> handleDuplicate(Exception e) {
    if (e instanceof MongoWriteException mwe
        && mwe.getError().getCategory() != ErrorCategory.DUPLICATE_KEY) {
      return handleUnexpected(e);
    }
    return ResponseEntity.status(ErrorCode.CONFLICT.status())
        .body(ApiError.of(ErrorCode.CONFLICT, "resource already exists", Map.of()));
  }

  @ExceptionHandler(Exception.class)
  public ResponseEntity<ApiError> handleUnexpected(Exception e) {
    log.error("unhandled exception", e);
    // Never leak internals - §19 security bar.
    return ResponseEntity.status(ErrorCode.INTERNAL_ERROR.status())
        .body(ApiError.of(ErrorCode.INTERNAL_ERROR, "internal error", Map.of()));
  }
}
