package io.hydropark;

import io.hydropark.config.AppProperties;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;

/**
 * One codebase, three trust zones (BACKEND-DESIGN §2, P1-21.1b). Which components load is decided
 * by {@code hydropark.api.enabled} / {@code hydropark.issuer.enabled} /
 * {@code hydropark.worker.enabled}, so the same image deploys as:
 *
 * <ul>
 *   <li><b>api</b> - public ingress, holds no MoR secret and no signing key
 *   <li><b>worker</b> - no public ingress; sole holder of the MoR webhook secret; only principal
 *       that may write {@code settled_orders} and {@code grants}
 *   <li><b>issuer</b> - no public ingress; sole holder of the Ed25519 private keys
 * </ul>
 *
 * <p>Locally, docker-compose runs all three as separate containers so the isolation boundary is
 * exercised in development rather than discovered in production.
 */
@SpringBootApplication
@EnableConfigurationProperties(AppProperties.class)
public class HydroparkApplication {

  public static void main(String[] args) {
    SpringApplication.run(HydroparkApplication.class, args);
  }
}
