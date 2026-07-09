package io.hydropark.security;

import io.hydropark.common.ApiException;
import io.hydropark.common.ErrorCode;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;

/** Reads the authenticated caller from the security context. */
public final class CurrentUser {

  private CurrentUser() {}

  /** Throws 401 when the request is anonymous. */
  public static AuthPrincipal require() {
    AuthPrincipal p = orNull();
    if (p == null) {
      throw new ApiException(ErrorCode.UNAUTHORIZED, "authentication required");
    }
    return p;
  }

  /** Null when anonymous - used by the optional-auth catalog endpoints (§4.2). */
  public static AuthPrincipal orNull() {
    Authentication auth = SecurityContextHolder.getContext().getAuthentication();
    return auth instanceof AuthPrincipal p ? p : null;
  }

  public static String requireUserId() {
    return require().userId();
  }
}
