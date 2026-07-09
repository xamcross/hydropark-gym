package io.hydropark.common;

import org.springframework.http.HttpStatus;

/**
 * The wire-level error vocabulary. BACKEND-DESIGN Appendix A fixes both the string codes and their
 * HTTP status, because clients branch on them (e.g. 402 insufficient_balance -> offer top-up).
 */
public enum ErrorCode {
  VALIDATION_ERROR("validation_error", HttpStatus.BAD_REQUEST),
  UNAUTHORIZED("unauthorized", HttpStatus.UNAUTHORIZED),
  FORBIDDEN("forbidden", HttpStatus.FORBIDDEN),
  NOT_FOUND("not_found", HttpStatus.NOT_FOUND),

  /** §4.7 - wallet spend exceeds settled balance. */
  INSUFFICIENT_BALANCE("insufficient_balance", HttpStatus.PAYMENT_REQUIRED),

  /** §4.6 - 5 active device slots already held. */
  SLOT_LIMIT_REACHED("slot_limit_reached", HttpStatus.CONFLICT),

  /** §5.5.4 - a wallet funds only purchases in its own currency. */
  WALLET_CURRENCY_MISMATCH("wallet_currency_mismatch", HttpStatus.CONFLICT),

  /** Appendix A - replay of an in-flight Idempotency-Key. */
  IDEMPOTENCY_REPLAY("idempotency_replay", HttpStatus.CONFLICT),

  CONFLICT("conflict", HttpStatus.CONFLICT),

  /** §8 SF11 - permanent effects (license issue, device register) need device confirmation. */
  STEP_UP_REQUIRED("step_up_required", HttpStatus.FORBIDDEN),

  /** §6.2 - no active grant, or the grant's order was never settled. */
  NOT_ENTITLED("not_entitled", HttpStatus.FORBIDDEN),

  /** §3.4 - device-churn / purchase-velocity trip. */
  RATE_LIMITED("rate_limited", HttpStatus.TOO_MANY_REQUESTS),

  /** §7.2 N9 - client region contradicts MoR buyer geo. */
  REGION_MISMATCH("region_mismatch", HttpStatus.CONFLICT),

  /** §5.5.5 - wallet frozen after a top-up chargeback. */
  WALLET_FROZEN("wallet_frozen", HttpStatus.FORBIDDEN),

  INTERNAL_ERROR("internal_error", HttpStatus.INTERNAL_SERVER_ERROR);

  private final String code;
  private final HttpStatus status;

  ErrorCode(String code, HttpStatus status) {
    this.code = code;
    this.status = status;
  }

  public String code() {
    return code;
  }

  public HttpStatus status() {
    return status;
  }
}
