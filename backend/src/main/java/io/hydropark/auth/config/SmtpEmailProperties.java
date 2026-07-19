package io.hydropark.auth.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/**
 * SMTP transactional-email config (P1-12.4), bound from {@code hydropark.email.smtp.*}. The
 * production {@code AuthEmailSender} is an SMTP adapter behind the existing port; the logging sender
 * stays the default so the app runs with no mail creds at all.
 *
 * <p><b>{@link #enabled} is the launch gate.</b> It defaults to {@code false}: without an explicit
 * {@code hydropark.email.smtp.enabled=true} the {@code SmtpAuthEmailSender} bean is never created and
 * no mail dependency is exercised - SMTP is inert until an operator supplies host/from creds and flips
 * the flag. None of these values is ever logged.
 *
 * <p>Lives in the {@code auth} package (not the shared {@code config} package) so it can be added
 * without touching foundation code; a {@code @Component}-annotated {@code @ConfigurationProperties}
 * bean is still bound by Spring Boot.
 */
@Component
@ConfigurationProperties(prefix = "hydropark.email.smtp")
public class SmtpEmailProperties {

  /** The launch gate. False by default = SMTP off, logging sender remains the default. */
  private boolean enabled = false;

  /** SMTP relay host, e.g. {@code email-smtp.eu-west-1.amazonaws.com}. */
  private String host = "";

  /** SMTP submission port; 587 (STARTTLS) by default. */
  private int port = 587;

  /** The {@code From:} address, e.g. {@code no-reply@hydropark.io}. */
  private String from = "";

  /** SMTP auth username; blank leaves auth off (an open relay / local MTA). */
  private String username = "";

  /** SMTP auth password. Never logged. */
  private String password = "";

  /** Whether to require STARTTLS on the submission connection. */
  private boolean startTls = true;

  public boolean isEnabled() {
    return enabled;
  }

  public void setEnabled(boolean enabled) {
    this.enabled = enabled;
  }

  public String getHost() {
    return host;
  }

  public void setHost(String host) {
    this.host = host;
  }

  public int getPort() {
    return port;
  }

  public void setPort(int port) {
    this.port = port;
  }

  public String getFrom() {
    return from;
  }

  public void setFrom(String from) {
    this.from = from;
  }

  public String getUsername() {
    return username;
  }

  public void setUsername(String username) {
    this.username = username;
  }

  public String getPassword() {
    return password;
  }

  public void setPassword(String password) {
    this.password = password;
  }

  public boolean isStartTls() {
    return startTls;
  }

  public void setStartTls(boolean startTls) {
    this.startTls = startTls;
  }
}
