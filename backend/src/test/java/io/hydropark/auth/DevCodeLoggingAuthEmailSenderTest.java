package io.hydropark.auth;

import static org.assertj.core.api.Assertions.assertThat;

import io.hydropark.auth.service.AuthEmailSender;
import io.hydropark.auth.service.DevCodeLoggingAuthEmailSender;
import io.hydropark.auth.service.LoggingAuthEmailSender;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

/**
 * The whole point of gating {@link DevCodeLoggingAuthEmailSender} behind {@code
 * hydropark.auth.log-codes} is that it can never load in an environment where nobody explicitly
 * opted in - in particular, it must not load just because {@code application.yml} exists and the
 * property is simply absent from it. This exercises the real {@code @ConditionalOnProperty} gate
 * via a Spring context, rather than asserting on the annotation reflectively.
 *
 * <p>Both sender classes are registered directly with {@link
 * ApplicationContextRunner#withUserConfiguration}, NOT wrapped in hand-written {@code @Bean}
 * factory methods - a {@code @Bean} method's condition is evaluated against the method/declaring
 * {@code @Configuration} class, not against the returned type's own class-level {@code
 * @Conditional} annotations, so wrapping them that way would silently bypass the gate and let this
 * test pass even if {@link DevCodeLoggingAuthEmailSender} were unconditional.
 */
class DevCodeLoggingAuthEmailSenderTest {

  private final ApplicationContextRunner contextRunner =
      new ApplicationContextRunner()
          .withUserConfiguration(LoggingAuthEmailSender.class, DevCodeLoggingAuthEmailSender.class);

  @Test
  void devSenderIsAbsentWhenThePropertyIsUnset() {
    contextRunner.run(
        context -> {
          // The whole point of the gate: with no hydropark.auth.log-codes=true opt-in, the
          // dev sender must not exist in the context at all - not disabled, not a no-op, absent.
          assertThat(context).doesNotHaveBean(DevCodeLoggingAuthEmailSender.class);
          assertThat(context).hasSingleBean(AuthEmailSender.class);
          assertThat(context.getBean(AuthEmailSender.class))
              .isInstanceOf(LoggingAuthEmailSender.class);
        });
  }

  @Test
  void devSenderIsAbsentWhenThePropertyIsExplicitlyFalse() {
    contextRunner
        .withPropertyValues("hydropark.auth.log-codes=false")
        .run(context -> assertThat(context).doesNotHaveBean(DevCodeLoggingAuthEmailSender.class));
  }

  @Test
  void devSenderTakesOverAndBecomesThePrimaryAuthEmailSenderWhenExplicitlyEnabled() {
    contextRunner
        .withPropertyValues("hydropark.auth.log-codes=true")
        .run(
            context -> {
              assertThat(context).hasSingleBean(DevCodeLoggingAuthEmailSender.class);
              // Two AuthEmailSender beans now exist; @Primary on the dev sender must break the tie.
              assertThat(context.getBean(AuthEmailSender.class))
                  .isInstanceOf(DevCodeLoggingAuthEmailSender.class);
            });
  }
}
