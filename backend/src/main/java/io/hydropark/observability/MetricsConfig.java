package io.hydropark.observability;

import io.hydropark.commerce.WebhookEvent;
import io.hydropark.commerce.WebhookEventStatus;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * P1-21.4 - wires the observability seam that {@link TelemetryMetrics} cannot register on its own:
 *
 * <ul>
 *   <li>the {@link HttpMetricsInterceptor}, which times every request per matched route;
 *   <li>the {@code hydropark.settlement.dlq.depth} gauge, which polls the datastore for the number of
 *       dead-lettered webhook events awaiting review.
 * </ul>
 *
 * <p>Gated on a servlet web application, mirroring {@link io.hydropark.config.SecurityConfig}: the
 * one-shot {@code migrate} job runs with {@code web-application-type=none} and has no MVC stack for a
 * {@link WebMvcConfigurer} to configure. All three trust zones (api/issuer/worker) are servlet apps,
 * so the interceptor is active in each; the DLQ gauge is additionally scoped to the worker zone,
 * which owns webhook settlement.
 */
@Configuration
@ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
public class MetricsConfig implements WebMvcConfigurer {

  private final MeterRegistry registry;

  public MetricsConfig(MeterRegistry registry) {
    this.registry = registry;
  }

  @Override
  public void addInterceptors(InterceptorRegistry interceptorRegistry) {
    interceptorRegistry.addInterceptor(new HttpMetricsInterceptor(registry));
  }

  /**
   * A polled gauge of the settlement dead-letter queue depth, read straight from {@code webhook_events}
   * (the worker's store) on each scrape. Scoped to the worker zone so the same series is not published
   * three times when the zones run as separate instances.
   */
  @Bean
  @ConditionalOnProperty(name = "hydropark.worker.enabled", havingValue = "true", matchIfMissing = true)
  Gauge settlementDlqDepthGauge(MeterRegistry meterRegistry, MongoTemplate mongo) {
    return Gauge.builder(TelemetryMetrics.SETTLEMENT_DLQ_DEPTH, () -> dlqDepth(mongo))
        .description("Dead-lettered webhook events awaiting review")
        .register(meterRegistry);
  }

  /** Count of {@code webhook_events} in the {@code dead_lettered} terminal state. */
  static long dlqDepth(MongoTemplate mongo) {
    return mongo.count(
        Query.query(Criteria.where("status").is(WebhookEventStatus.DEAD_LETTERED.wire())),
        WebhookEvent.class);
  }
}
