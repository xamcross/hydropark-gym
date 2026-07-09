package io.hydropark.migration;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.ApplicationContext;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/**
 * Turns the image into a one-shot job: run every {@link ApplicationRunner}, then exit 0.
 *
 * <p>Ordered {@link Ordered#LOWEST_PRECEDENCE} so it fires strictly after migrations
 * ({@code @Order(1)}) and the catalog seeder ({@code @Order(2)}). This is the mode used by
 * docker-compose's {@code migrate} service and by Fly's {@code [deploy] release_command}, so the
 * schema is advanced - and, in dev, seeded - by a process that runs to completion <em>before</em>
 * any instance serves traffic, rather than by whichever replica happened to boot first.
 *
 * <p>Gated only on {@code exit-after}, independent of {@code migration.enabled}: a job that only
 * seeds must still be able to terminate.
 */
@Component
@Order(Ordered.LOWEST_PRECEDENCE)
@ConditionalOnProperty(name = "hydropark.migration.exit-after", havingValue = "true")
public class OneShotExitRunner implements ApplicationRunner {

  private static final Logger log = LoggerFactory.getLogger(OneShotExitRunner.class);

  private final ApplicationContext context;

  public OneShotExitRunner(ApplicationContext context) {
    this.context = context;
  }

  @Override
  public void run(ApplicationArguments args) {
    log.info("one-shot mode: all startup runners complete, exiting");
    System.exit(SpringApplication.exit(context, () -> 0));
  }
}
