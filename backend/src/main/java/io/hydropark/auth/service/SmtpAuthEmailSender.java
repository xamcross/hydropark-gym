package io.hydropark.auth.service;

import io.hydropark.auth.config.SmtpEmailProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Primary;
import org.springframework.mail.SimpleMailMessage;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.stereotype.Component;

/**
 * Production {@link AuthEmailSender} (P1-12.4): the SMTP adapter behind the auth email port, sending
 * the out-of-band secrets auth generates through Spring's {@link JavaMailSender}. It slots in behind
 * the <em>existing</em> port - {@link AuthService} calls the same three methods and never learns which
 * binding it got.
 *
 * <p><b>Off by default; a launch gate.</b> Gated on {@code hydropark.email.smtp.enabled=true} ({@link
 * SmtpEmailProperties}), so with no SMTP creds the bean is never created and {@link
 * LoggingAuthEmailSender} stays the default - the app is fully functional without a mail provider.
 * When enabled it is {@link Primary} so it wins over the logging default, exactly as {@link
 * DevCodeLoggingAuthEmailSender} does for local dev. (The dev-code and SMTP senders are mutually
 * exclusive deployments - never enable {@code hydropark.auth.log-codes} and {@code
 * hydropark.email.smtp.enabled} together.)
 *
 * <p>Like the logging sender, this <b>never logs the secret</b> - it goes only into the message body,
 * which carries a bearer credential. The subject/body copy is intentionally minimal; richer templates
 * are a later concern than getting real delivery behind the launch gate.
 */
@Component
@ConditionalOnProperty(name = "hydropark.email.smtp.enabled", havingValue = "true")
@Primary
public class SmtpAuthEmailSender implements AuthEmailSender {

  private static final Logger log = LoggerFactory.getLogger(SmtpAuthEmailSender.class);

  private final JavaMailSender mail;
  private final SmtpEmailProperties props;

  public SmtpAuthEmailSender(JavaMailSender mail, SmtpEmailProperties props) {
    this.mail = mail;
    this.props = props;
  }

  @Override
  public void sendVerification(String email, String verifyToken) {
    send(
        email,
        "Verify your Hydropark email",
        "Confirm your email address with this code:\n\n" + verifyToken);
  }

  @Override
  public void sendPasswordReset(String email, String resetToken) {
    send(
        email,
        "Reset your Hydropark password",
        "Use this token to reset your password:\n\n" + resetToken);
  }

  @Override
  public void sendStepUpCode(String email, String code) {
    send(email, "Your Hydropark confirmation code", "Your one-time confirmation code is:\n\n" + code);
  }

  private void send(String to, String subject, String body) {
    SimpleMailMessage message = new SimpleMailMessage();
    message.setFrom(props.getFrom());
    message.setTo(to);
    message.setSubject(subject);
    message.setText(body);
    mail.send(message);
    // Log the delivery, never the secret - the body is a bearer credential.
    log.info("sent auth mail '{}' to {}", subject, mask(to));
  }

  private static String mask(String email) {
    if (email == null) {
      return "<none>";
    }
    int at = email.indexOf('@');
    return at <= 1 ? "***" : email.charAt(0) + "***" + email.substring(at);
  }
}
