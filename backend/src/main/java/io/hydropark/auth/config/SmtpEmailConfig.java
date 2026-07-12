package io.hydropark.auth.config;

import java.util.Properties;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.mail.javamail.JavaMailSenderImpl;

/**
 * Builds the {@link JavaMailSender} the P1-12.4 {@code SmtpAuthEmailSender} sends through, wired from
 * {@link SmtpEmailProperties} - our own {@code hydropark.email.smtp.*} surface, not {@code
 * spring.mail.*} - so the launch gate ({@code hydropark.email.smtp.enabled}) governs both the sender
 * and its transport from one flag.
 *
 * <p>Gated on {@code hydropark.email.smtp.enabled=true}: without the opt-in no mail transport is
 * created at all. {@link ConditionalOnMissingBean} defers to any {@link JavaMailSender} an operator
 * has configured through Spring Boot's own {@code spring.mail.*} autoconfiguration, so the two paths
 * never collide.
 */
@Configuration
@ConditionalOnProperty(name = "hydropark.email.smtp.enabled", havingValue = "true")
public class SmtpEmailConfig {

  @Bean
  @ConditionalOnMissingBean(JavaMailSender.class)
  JavaMailSender hydroparkMailSender(SmtpEmailProperties props) {
    JavaMailSenderImpl sender = new JavaMailSenderImpl();
    sender.setHost(props.getHost());
    sender.setPort(props.getPort());
    if (!props.getUsername().isBlank()) {
      sender.setUsername(props.getUsername());
      sender.setPassword(props.getPassword());
    }
    Properties mail = sender.getJavaMailProperties();
    mail.put("mail.transport.protocol", "smtp");
    mail.put("mail.smtp.auth", String.valueOf(!props.getUsername().isBlank()));
    mail.put("mail.smtp.starttls.enable", String.valueOf(props.isStartTls()));
    return sender;
  }
}
