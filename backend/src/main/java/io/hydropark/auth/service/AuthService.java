package io.hydropark.auth.service;

import io.hydropark.auth.domain.EmailVerificationToken;
import io.hydropark.auth.domain.PasswordResetToken;
import io.hydropark.auth.domain.User;
import io.hydropark.auth.repo.EmailVerificationTokenRepository;
import io.hydropark.auth.repo.PasswordResetTokenRepository;
import io.hydropark.auth.repo.UserRepository;
import io.hydropark.auth.support.Emails;
import io.hydropark.auth.support.Tokens;
import io.hydropark.common.ApiException;
import io.hydropark.common.ErrorCode;
import io.hydropark.common.Uuid7;
import io.hydropark.config.AppProperties;
import java.time.Instant;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;

/**
 * Email/password + device-only account lifecycle (§4.1). Two properties carry weight here:
 *
 * <ul>
 *   <li><b>No user enumeration.</b> Login does equal work and returns one indistinguishable error for
 *       unknown-email vs. bad-password vs. passwordless account; {@code password/reset-request} always
 *       succeeds silently.
 *   <li><b>Nullable password.</b> Device-only and OAuth-only accounts have no {@code password_hash};
 *       a password login against them fails exactly like a wrong password.
 * </ul>
 */
@Service
public class AuthService {

  private final UserRepository users;
  private final EmailVerificationTokenRepository verifyTokens;
  private final PasswordResetTokenRepository resetTokens;
  private final PasswordEncoder passwordEncoder;
  private final RefreshTokenService refreshTokens;
  private final AuthEmailSender email;
  private final AppProperties props;

  /** Constant dummy hash so an unknown-user login burns the same Argon2 work as a real one. */
  private final String dummyHash;

  public AuthService(
      UserRepository users,
      EmailVerificationTokenRepository verifyTokens,
      PasswordResetTokenRepository resetTokens,
      PasswordEncoder passwordEncoder,
      RefreshTokenService refreshTokens,
      AuthEmailSender email,
      AppProperties props) {
    this.users = users;
    this.verifyTokens = verifyTokens;
    this.resetTokens = resetTokens;
    this.passwordEncoder = passwordEncoder;
    this.refreshTokens = refreshTokens;
    this.email = email;
    this.props = props;
    this.dummyHash = passwordEncoder.encode(Tokens.opaque());
  }

  /** Login/register outcome. {@code recoveryCode} is non-null only for a fresh device-only account. */
  public record Issued(AuthTokens tokens, User user, String recoveryCode) {}

  // ---- register ---------------------------------------------------------------------------------

  public Issued register(String rawEmail, String rawPassword) {
    String normalizedEmail = Emails.normalize(rawEmail);
    Instant now = Instant.now();

    if (normalizedEmail != null && users.existsByEmail(normalizedEmail)) {
      throw new ApiException(ErrorCode.CONFLICT, "email already registered");
    }

    String passwordHash = rawPassword == null ? null : passwordEncoder.encode(rawPassword);

    // A pure device-only account (no email) gets a one-time recovery code, its only step-up factor.
    String recoveryCode = null;
    String recoveryCodeHash = null;
    if (normalizedEmail == null) {
      recoveryCode = Tokens.code();
      recoveryCodeHash = Tokens.sha256(recoveryCode);
    }

    User user =
        new User(Uuid7.generate(), normalizedEmail, passwordHash, recoveryCodeHash, now);
    try {
      users.save(user);
    } catch (DuplicateKeyException e) {
      // Lost the race against the collation-unique email index.
      throw new ApiException(ErrorCode.CONFLICT, "email already registered");
    }

    if (normalizedEmail != null) {
      sendVerificationMail(user, now);
    }

    return new Issued(refreshTokens.issueNewFamily(user), user, recoveryCode);
  }

  // ---- login ------------------------------------------------------------------------------------

  public Issued login(String rawEmail, String rawPassword) {
    String normalizedEmail = Emails.normalize(rawEmail);
    User user = normalizedEmail == null ? null : users.findByEmail(normalizedEmail).orElse(null);

    // Equal work on every path: always run one Argon2 verification, against a dummy hash if needed.
    String hashToCheck = user != null && user.getPasswordHash() != null
        ? user.getPasswordHash()
        : dummyHash;
    boolean passwordOk = passwordEncoder.matches(rawPassword == null ? "" : rawPassword, hashToCheck);

    boolean valid =
        user != null
            && user.getPasswordHash() != null
            && User.STATUS_ACTIVE.equals(user.getStatus())
            && passwordOk;
    if (!valid) {
      // One indistinguishable error for unknown-email, bad-password, passwordless, or inactive.
      throw new ApiException(ErrorCode.UNAUTHORIZED, "invalid credentials");
    }
    return new Issued(refreshTokens.issueNewFamily(user), user, null);
  }

  // ---- email verification -----------------------------------------------------------------------

  public void verifyEmail(String verifyToken) {
    EmailVerificationToken token =
        verifyTokens.findById(Tokens.sha256(verifyToken)).orElse(null);
    if (token == null || token.getExpiresAt().isBefore(Instant.now())) {
      throw new ApiException(ErrorCode.VALIDATION_ERROR, "invalid or expired verification token");
    }
    User user = users.findById(token.getUserId()).orElse(null);
    if (user != null && !user.isEmailVerified()) {
      user.setEmailVerified(true);
      user.setUpdatedAt(Instant.now());
      users.save(user);
    }
    verifyTokens.delete(token); // single-use
  }

  public void resendVerification(String userId) {
    User user = requireUser(userId);
    if (user.getEmail() == null) {
      throw new ApiException(ErrorCode.VALIDATION_ERROR, "no email on file");
    }
    if (user.isEmailVerified()) {
      return; // idempotent: already verified
    }
    sendVerificationMail(user, Instant.now());
  }

  // ---- password reset ---------------------------------------------------------------------------

  /** Always succeeds silently - the caller returns 200 regardless, so no email is enumerable. */
  public void requestPasswordReset(String rawEmail) {
    String normalizedEmail = Emails.normalize(rawEmail);
    if (normalizedEmail == null) {
      return;
    }
    User user = users.findByEmail(normalizedEmail).orElse(null);
    if (user == null || user.getEmail() == null) {
      return;
    }
    Instant now = Instant.now();
    String token = Tokens.opaque();
    resetTokens.save(
        new PasswordResetToken(
            Tokens.sha256(token),
            user.getId(),
            now.plusSeconds(props.getAuth().getPasswordResetTtlSeconds()),
            now));
    email.sendPasswordReset(user.getEmail(), token);
  }

  public void resetPassword(String resetToken, String newPassword) {
    PasswordResetToken token = resetTokens.findById(Tokens.sha256(resetToken)).orElse(null);
    if (token == null || token.getExpiresAt().isBefore(Instant.now())) {
      throw new ApiException(ErrorCode.VALIDATION_ERROR, "invalid or expired reset token");
    }
    User user = users.findById(token.getUserId()).orElse(null);
    if (user == null) {
      resetTokens.delete(token);
      throw new ApiException(ErrorCode.VALIDATION_ERROR, "invalid or expired reset token");
    }
    user.setPasswordHash(passwordEncoder.encode(newPassword));
    user.setUpdatedAt(Instant.now());
    users.save(user);
    resetTokens.delete(token); // single-use
    // A reset is a credential change: drop every outstanding session.
    refreshTokens.revokeAllForUser(user.getId());
  }

  // ---- logout -----------------------------------------------------------------------------------

  public void logout(String refreshToken) {
    refreshTokens.revokeFamilyOf(refreshToken);
  }

  // ---- helpers ----------------------------------------------------------------------------------

  private void sendVerificationMail(User user, Instant now) {
    String token = Tokens.opaque();
    verifyTokens.save(
        new EmailVerificationToken(
            Tokens.sha256(token),
            user.getId(),
            now.plusSeconds(props.getAuth().getEmailVerificationTtlSeconds()),
            now));
    email.sendVerification(user.getEmail(), token);
  }

  private User requireUser(String userId) {
    return users
        .findById(userId)
        .filter(u -> User.STATUS_ACTIVE.equals(u.getStatus()))
        .orElseThrow(() -> new ApiException(ErrorCode.UNAUTHORIZED, "account not found"));
  }
}
