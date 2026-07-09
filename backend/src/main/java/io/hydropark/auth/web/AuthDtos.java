package io.hydropark.auth.web;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import io.hydropark.auth.domain.User;
import io.hydropark.auth.service.AuthService.Issued;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.time.Instant;

/** Request/response wire records for {@link AuthController} (§4.1). Wire fields are snake_case. */
public final class AuthDtos {

  private AuthDtos() {}

  // ---- requests ---------------------------------------------------------------------------------

  /** email and password are both optional: neither ⇒ a device-only account. */
  public record RegisterRequest(@Email String email, @Size(min = 8, max = 200) String password) {}

  public record LoginRequest(@NotBlank String email, @NotBlank String password) {}

  public record RefreshRequest(@JsonProperty("refresh_token") @NotBlank String refreshToken) {}

  public record OAuthRequest(
      @JsonProperty("id_token") @NotBlank String idToken, @NotBlank String nonce) {}

  public record VerifyEmailRequest(
      @JsonProperty("verify_token") @NotBlank String verifyToken) {}

  public record LogoutRequest(@JsonProperty("refresh_token") @NotBlank String refreshToken) {}

  public record ResetRequestRequest(@NotBlank String email) {}

  public record ResetRequest(
      @JsonProperty("reset_token") @NotBlank String resetToken,
      @JsonProperty("new_password") @Size(min = 8, max = 200) @NotBlank String newPassword) {}

  public record StepUpBeginRequest(@NotBlank String action) {}

  public record StepUpOAuthRequest(
      @JsonProperty("id_token") @NotBlank String idToken,
      @NotBlank String nonce,
      @NotBlank String action) {}

  // ---- responses --------------------------------------------------------------------------------

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record UserView(
      String id, String email, @JsonProperty("email_verified") boolean emailVerified) {
    public static UserView of(User u) {
      return new UserView(u.getId(), u.getEmail(), u.isEmailVerified());
    }
  }

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record AuthResponse(
      @JsonProperty("access_jwt") String accessJwt,
      @JsonProperty("refresh_token") String refreshToken,
      UserView user,
      @JsonProperty("recovery_code") String recoveryCode) {

    public static AuthResponse of(Issued issued) {
      return new AuthResponse(
          issued.tokens().accessJwt(),
          issued.tokens().refreshToken(),
          UserView.of(issued.user()),
          issued.recoveryCode());
    }
  }

  public record TokenPair(
      @JsonProperty("access_jwt") String accessJwt,
      @JsonProperty("refresh_token") String refreshToken) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record StepUpBeginResponse(
      @JsonProperty("challenge_id") String challengeId,
      String factor,
      @JsonProperty("expires_at") Instant expiresAt) {}

  @JsonInclude(JsonInclude.Include.NON_NULL)
  public record StepUpTokenResponse(
      @JsonProperty("step_up_token") String stepUpToken,
      @JsonProperty("expires_at") Instant expiresAt) {}
}
