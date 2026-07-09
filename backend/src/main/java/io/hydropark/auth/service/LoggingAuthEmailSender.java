package io.hydropark.auth.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Default {@link AuthEmailSender}: logs that a mail would be sent, never the secret itself. A real
 * transactional-email binding can replace it by defining another {@link AuthEmailSender} bean marked
 * {@code @Primary}.
 *
 * <p>The secret is deliberately never logged - it is a bearer credential, and logging it would defeat
 * the "store only the hash" property.
 */
@Component
public class LoggingAuthEmailSender implements AuthEmailSender {

  private static final Logger log = LoggerFactory.getLogger(LoggingAuthEmailSender.class);

  @Override
  public void sendVerification(String email, String verifyToken) {
    log.info("would send email-verification mail to {}", mask(email));
  }

  @Override
  public void sendPasswordReset(String email, String resetToken) {
    log.info("would send password-reset mail to {}", mask(email));
  }

  @Override
  public void sendStepUpCode(String email, String code) {
    log.info("would send step-up code to {}", mask(email));
  }

  private static String mask(String email) {
    if (email == null) {
      return "<none>";
    }
    int at = email.indexOf('@');
    return at <= 1 ? "***" : email.charAt(0) + "***" + email.substring(at);
  }
}
