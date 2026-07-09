package io.hydropark.auth.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Primary;
import org.springframework.stereotype.Component;

/**
 * Dev-only {@link AuthEmailSender} that logs the actual out-of-band secret (email-verification
 * code, password-reset token, step-up one-time code) instead of suppressing it, so step-up and
 * email-verification flows can be exercised end-to-end in local development without hand-inserting
 * a hashed challenge into MongoDB.
 *
 * <p><b>Off by default.</b> Only activates when {@code hydropark.auth.log-codes=true} is
 * explicitly set, and then takes precedence over {@link LoggingAuthEmailSender} via {@link
 * Primary}. This must never be enabled in a deployed environment: it defeats the "store only the
 * hash, never the secret" property the rest of the auth package relies on (see {@link
 * StepUpService}, password-reset and email-verification token handling in {@link AuthService}).
 *
 * <p>{@link AuthEmailSender} passes only the recipient email and the secret itself - it does not
 * receive the userId or (for step-up) the action being stepped up for. Rather than widen that
 * interface for a dev-only concern, the log lines below identify the account by email instead of
 * userId, and the step-up line carries no action.
 */
@Component
@ConditionalOnProperty(name = "hydropark.auth.log-codes", havingValue = "true")
@Primary
public class DevCodeLoggingAuthEmailSender implements AuthEmailSender {

  private static final Logger log = LoggerFactory.getLogger(DevCodeLoggingAuthEmailSender.class);

  public DevCodeLoggingAuthEmailSender() {
    log.warn(
        "hydropark.auth.log-codes=true -- email-verification codes, password-reset tokens, and "
            + "step-up one-time codes are being written to the application log IN CLEARTEXT. This "
            + "is a local-development escape hatch only and MUST NEVER be enabled in a deployed "
            + "environment: it defeats the store-only-the-hash property the auth package relies on.");
  }

  @Override
  public void sendVerification(String email, String verifyToken) {
    log.info("DEV-CODE type=email_verify user={} code={}", email, verifyToken);
  }

  @Override
  public void sendPasswordReset(String email, String resetToken) {
    log.info("DEV-CODE type=password_reset user={} code={}", email, resetToken);
  }

  @Override
  public void sendStepUpCode(String email, String code) {
    log.info("DEV-CODE type=step_up user={} code={}", email, code);
  }
}
