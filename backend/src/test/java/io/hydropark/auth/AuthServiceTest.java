package io.hydropark.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import io.hydropark.auth.domain.User;
import io.hydropark.auth.repo.EmailVerificationTokenRepository;
import io.hydropark.auth.repo.PasswordResetTokenRepository;
import io.hydropark.auth.repo.UserRepository;
import io.hydropark.auth.service.AuthEmailSender;
import io.hydropark.auth.service.AuthService;
import io.hydropark.auth.service.RefreshTokenService;
import io.hydropark.common.ApiException;
import io.hydropark.common.ErrorCode;
import io.hydropark.config.AppProperties;
import java.time.Instant;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.security.crypto.password.PasswordEncoder;

/**
 * §4.1 no-user-enumeration guarantees. {@code password/reset-request} always succeeds silently, and
 * login failures are indistinguishable across unknown-email, bad-password, and passwordless accounts.
 */
class AuthServiceTest {

  private UserRepository users;
  private PasswordResetTokenRepository resetTokens;
  private PasswordEncoder encoder;
  private AuthEmailSender email;
  private AuthService service;

  @BeforeEach
  void setUp() {
    users = mock(UserRepository.class);
    EmailVerificationTokenRepository verifyTokens = mock(EmailVerificationTokenRepository.class);
    resetTokens = mock(PasswordResetTokenRepository.class);
    encoder = mock(PasswordEncoder.class);
    RefreshTokenService refreshTokens = mock(RefreshTokenService.class);
    email = mock(AuthEmailSender.class);
    when(encoder.encode(anyString())).thenReturn("dummy-hash"); // used for the constant dummy hash
    service =
        new AuthService(
            users, verifyTokens, resetTokens, encoder, refreshTokens, email, new AppProperties());
  }

  @Test
  void resetRequestForAnUnknownEmailDoesNothingAndDoesNotThrow() {
    when(users.findByEmail("ghost@example.com")).thenReturn(Optional.empty());

    assertThatCode(() -> service.requestPasswordReset("ghost@example.com"))
        .doesNotThrowAnyException();

    verify(resetTokens, never()).save(any());
    verify(email, never()).sendPasswordReset(anyString(), anyString());
  }

  @Test
  void resetRequestForAKnownEmailIssuesATokenButLooksIdenticalToTheCaller() {
    User user = new User("u1", "known@example.com", "hash", null, Instant.now());
    when(users.findByEmail("known@example.com")).thenReturn(Optional.of(user));

    // Mixed-case input is normalised to the stored lower-case email.
    assertThatCode(() -> service.requestPasswordReset("Known@Example.com"))
        .doesNotThrowAnyException();

    verify(resetTokens).save(any());
    verify(email).sendPasswordReset(eq("known@example.com"), anyString());
  }

  @Test
  void loginFailuresAreIndistinguishableForUnknownEmailVersusBadPassword() {
    // Unknown email: matched against the dummy hash, still fails.
    when(users.findByEmail("nobody@example.com")).thenReturn(Optional.empty());
    when(encoder.matches(any(), any())).thenReturn(false);

    ApiException unknown =
        catchApi(() -> service.login("nobody@example.com", "whatever"));

    // Known email, wrong password.
    User user = new User("u2", "real@example.com", "stored-hash", null, Instant.now());
    when(users.findByEmail("real@example.com")).thenReturn(Optional.of(user));

    ApiException badPassword = catchApi(() -> service.login("real@example.com", "wrong"));

    assertThat(unknown.errorCode()).isEqualTo(ErrorCode.UNAUTHORIZED);
    assertThat(badPassword.errorCode()).isEqualTo(ErrorCode.UNAUTHORIZED);
    // Same wire code AND same message: the two cases cannot be told apart.
    assertThat(unknown.getMessage()).isEqualTo(badPassword.getMessage());
  }

  private static ApiException catchApi(Runnable r) {
    ApiException[] holder = new ApiException[1];
    assertThatThrownBy(r::run)
        .isInstanceOf(ApiException.class)
        .satisfies(e -> holder[0] = (ApiException) e);
    return holder[0];
  }
}
