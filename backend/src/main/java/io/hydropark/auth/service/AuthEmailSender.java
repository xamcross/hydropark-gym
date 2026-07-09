package io.hydropark.auth.service;

/**
 * Delivers the out-of-band secrets auth generates. The production binding is a transactional email
 * provider (§9); a no-op logging binding ships for dev/tests. Kept as a port so tests can capture the
 * emitted secret without a real mailbox.
 */
public interface AuthEmailSender {

  void sendVerification(String email, String verifyToken);

  void sendPasswordReset(String email, String resetToken);

  void sendStepUpCode(String email, String code);
}
