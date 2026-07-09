package io.hydropark.migration;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/**
 * Runs pending migrations at boot, before anything else.
 *
 * <p>This runner deliberately does <b>not</b> terminate the JVM. Exiting is
 * {@link OneShotExitRunner}'s job, and it is ordered last. An earlier version of this class called
 * {@code System.exit} here: because {@code ApplicationRunner}s are invoked sequentially on one
 * thread in {@code @Order} sequence, that halted the JVM before the {@code @Order(2)} catalog seeder
 * ever ran - so a "migrate and seed" job silently skipped the seed and still exited 0. Keep the
 * "do work" and "stop the process" concerns apart.
 */
@Component
@Order(1)
@ConditionalOnProperty(name = "hydropark.migration.enabled", havingValue = "true", matchIfMissing = true)
public class MigrationBootstrap implements ApplicationRunner {

  private static final Logger log = LoggerFactory.getLogger(MigrationBootstrap.class);

  private final MigrationRunner runner;

  public MigrationBootstrap(MigrationRunner runner) {
    this.runner = runner;
  }

  @Override
  public void run(ApplicationArguments args) {
    int applied = runner.run();
    log.info("migration bootstrap complete: {} migration(s) applied", applied);
  }
}
