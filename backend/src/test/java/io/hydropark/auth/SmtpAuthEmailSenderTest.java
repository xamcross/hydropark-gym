package io.hydropark.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

import io.hydropark.auth.config.SmtpEmailProperties;
import io.hydropark.auth.service.AuthEmailSender;
import io.hydropark.auth.service.LoggingAuthEmailSender;
import io.hydropark.auth.service.SmtpAuthEmailSender;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.mail.SimpleMailMessage;
import org.springframework.mail.javamail.JavaMailSender;

/**
 * P1-12.4: the SMTP sender is a launch gate. Like {@code DevCodeLoggingAuthEmailSender}, it must never
 * load unless an operator explicitly opts in - {@code hydropark.email.smtp.enabled=true} - so with no
 * creds the {@link LoggingAuthEmailSender} default stays in force and no mail is ever attempted. The
 * conditional is exercised through a real Spring context, not asserted reflectively. A second, plain
 * unit test pins that when it <em>is</em> active it sends through {@link JavaMailSender} with the
 * configured {@code From:}.
 */
class SmtpAuthEmailSenderTest {

  private final ApplicationContextRunner contextRunner =
      new ApplicationContextRunner()
          .withBean(JavaMailSender.class, () -> mock(JavaMailSender.class))
          .withBean(SmtpEmailProperties.class, SmtpEmailProperties::new)
          .withUserConfiguration(LoggingAuthEmailSender.class, SmtpAuthEmailSender.class);

  @Test
  void smtpSenderIsAbsentWhenThePropertyIsUnset() {
    contextRunner.run(
        context -> {
          // No opt-in: the SMTP sender must not exist at all - the logging default stands.
          assertThat(context).doesNotHaveBean(SmtpAuthEmailSender.class);
          assertThat(context).hasSingleBean(AuthEmailSender.class);
          assertThat(context.getBean(AuthEmailSender.class))
              .isInstanceOf(LoggingAuthEmailSender.class);
        });
  }

  @Test
  void smtpSenderIsAbsentWhenThePropertyIsExplicitlyFalse() {
    contextRunner
        .withPropertyValues("hydropark.email.smtp.enabled=false")
        .run(context -> assertThat(context).doesNotHaveBean(SmtpAuthEmailSender.class));
  }

  @Test
  void smtpSenderBecomesThePrimaryAuthEmailSenderWhenExplicitlyEnabled() {
    contextRunner
        .withPropertyValues("hydropark.email.smtp.enabled=true")
        .run(
            context -> {
              assertThat(context).hasSingleBean(SmtpAuthEmailSender.class);
              // Two AuthEmailSender beans now exist; @Primary on the SMTP sender must break the tie.
              assertThat(context.getBean(AuthEmailSender.class))
                  .isInstanceOf(SmtpAuthEmailSender.class);
            });
  }

  @Test
  void whenActiveItSendsThroughJavaMailSenderWithTheConfiguredFrom() {
    JavaMailSender mail = mock(JavaMailSender.class);
    SmtpEmailProperties props = new SmtpEmailProperties();
    props.setFrom("no-reply@hydropark.io");

    new SmtpAuthEmailSender(mail, props).sendStepUpCode("user@example.com", "123456");

    ArgumentCaptor<SimpleMailMessage> sent = ArgumentCaptor.forClass(SimpleMailMessage.class);
    verify(mail).send(sent.capture());
    SimpleMailMessage message = sent.getValue();
    assertThat(message.getFrom()).isEqualTo("no-reply@hydropark.io");
    assertThat(message.getTo()).containsExactly("user@example.com");
    assertThat(message.getText()).contains("123456");
  }
}
