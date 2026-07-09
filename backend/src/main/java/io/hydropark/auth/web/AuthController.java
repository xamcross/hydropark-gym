package io.hydropark.auth.web;

import io.hydropark.auth.service.AuthService;
import io.hydropark.auth.service.AuthTokens;
import io.hydropark.auth.service.OAuthService;
import io.hydropark.auth.service.StepUpService;
import io.hydropark.auth.web.AuthDtos.AuthResponse;
import io.hydropark.auth.web.AuthDtos.LoginRequest;
import io.hydropark.auth.web.AuthDtos.LogoutRequest;
import io.hydropark.auth.web.AuthDtos.OAuthRequest;
import io.hydropark.auth.web.AuthDtos.RefreshRequest;
import io.hydropark.auth.web.AuthDtos.RegisterRequest;
import io.hydropark.auth.web.AuthDtos.ResetRequest;
import io.hydropark.auth.web.AuthDtos.ResetRequestRequest;
import io.hydropark.auth.web.AuthDtos.StepUpBeginRequest;
import io.hydropark.auth.web.AuthDtos.StepUpBeginResponse;
import io.hydropark.auth.web.AuthDtos.StepUpOAuthRequest;
import io.hydropark.auth.web.AuthDtos.StepUpTokenResponse;
import io.hydropark.auth.web.AuthDtos.TokenPair;
import io.hydropark.auth.web.AuthDtos.VerifyEmailRequest;
import io.hydropark.security.CurrentUser;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * §4.1 Auth endpoints under {@code /v1/auth}. This path prefix is {@code permitAll} in the security
 * chain (login/refresh present their own credential in the body), so the endpoints that DO need an
 * access token enforce it explicitly via {@link CurrentUser#require()}.
 */
@RestController
@RequestMapping("/v1/auth")
public class AuthController {

  private final AuthService auth;
  private final OAuthService oauth;
  private final io.hydropark.auth.service.RefreshTokenService refreshTokens;
  private final StepUpService stepUp;

  public AuthController(
      AuthService auth,
      OAuthService oauth,
      io.hydropark.auth.service.RefreshTokenService refreshTokens,
      StepUpService stepUp) {
    this.auth = auth;
    this.oauth = oauth;
    this.refreshTokens = refreshTokens;
    this.stepUp = stepUp;
  }

  @PostMapping("/register")
  public AuthResponse register(@Valid @RequestBody RegisterRequest req) {
    return AuthResponse.of(auth.register(req.email(), req.password()));
  }

  @PostMapping("/login")
  public AuthResponse login(@Valid @RequestBody LoginRequest req) {
    return AuthResponse.of(auth.login(req.email(), req.password()));
  }

  @PostMapping("/refresh")
  public TokenPair refresh(@Valid @RequestBody RefreshRequest req) {
    AuthTokens t = refreshTokens.rotate(req.refreshToken());
    return new TokenPair(t.accessJwt(), t.refreshToken());
  }

  @PostMapping("/oauth/{provider}")
  public AuthResponse oauth(@PathVariable String provider, @Valid @RequestBody OAuthRequest req) {
    return AuthResponse.of(oauth.loginOrRegister(provider, req.idToken(), req.nonce()));
  }

  @PostMapping("/verify-email")
  public ResponseEntity<Void> verifyEmail(@Valid @RequestBody VerifyEmailRequest req) {
    auth.verifyEmail(req.verifyToken());
    return ResponseEntity.noContent().build();
  }

  @PostMapping("/verify-email/resend")
  public ResponseEntity<Void> resendVerification() {
    auth.resendVerification(CurrentUser.requireUserId());
    return ResponseEntity.noContent().build();
  }

  @PostMapping("/logout")
  public ResponseEntity<Void> logout(@Valid @RequestBody LogoutRequest req) {
    auth.logout(req.refreshToken());
    return ResponseEntity.noContent().build();
  }

  @PostMapping("/password/reset-request")
  public ResponseEntity<Void> resetRequest(@Valid @RequestBody ResetRequestRequest req) {
    // Always 200, whether or not the email exists (no user enumeration, §4.1).
    auth.requestPasswordReset(req.email());
    return ResponseEntity.noContent().build();
  }

  @PostMapping("/password/reset")
  public ResponseEntity<Void> resetPassword(@Valid @RequestBody ResetRequest req) {
    auth.resetPassword(req.resetToken(), req.newPassword());
    return ResponseEntity.noContent().build();
  }

  // ---- step-up (§8) -----------------------------------------------------------------------------

  @PostMapping("/step-up/begin")
  public StepUpBeginResponse stepUpBegin(@Valid @RequestBody StepUpBeginRequest req) {
    StepUpService.BeginResult r = stepUp.begin(CurrentUser.requireUserId(), req.action());
    return new StepUpBeginResponse(r.challengeId(), r.factor(), r.expiresAt());
  }

  @PostMapping("/step-up/oauth/{provider}")
  public StepUpTokenResponse stepUpOAuth(
      @PathVariable String provider, @Valid @RequestBody StepUpOAuthRequest req) {
    StepUpService.StepUpToken t =
        stepUp.beginViaOAuth(
            CurrentUser.requireUserId(), provider, req.idToken(), req.nonce(), req.action());
    return new StepUpTokenResponse(t.stepUpToken(), t.expiresAt());
  }
}
