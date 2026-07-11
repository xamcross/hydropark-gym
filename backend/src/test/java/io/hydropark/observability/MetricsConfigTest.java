package io.hydropark.observability;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import io.hydropark.commerce.WebhookEvent;
import io.hydropark.commerce.WebhookEventStatus;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Query;

/**
 * P1-21.4 - the DLQ-depth gauge reads the count of dead-lettered {@code webhook_events}. Headless:
 * the datastore is a Mockito {@link MongoTemplate}, so no Testcontainers/Docker is required.
 */
@ExtendWith(MockitoExtension.class)
class MetricsConfigTest {

  @Mock MongoTemplate mongo;

  @Test
  void dlqDepthCountsOnlyDeadLetteredEvents() {
    when(mongo.count(any(Query.class), eq(WebhookEvent.class))).thenReturn(4L);

    long depth = MetricsConfig.dlqDepth(mongo);

    assertThat(depth).isEqualTo(4L);
    ArgumentCaptor<Query> q = ArgumentCaptor.forClass(Query.class);
    verify(mongo).count(q.capture(), eq(WebhookEvent.class));
    assertThat(q.getValue().getQueryObject().get("status"))
        .isEqualTo(WebhookEventStatus.DEAD_LETTERED.wire());
  }

  @Test
  void gaugeRegistersAndReportsCurrentDepth() {
    SimpleMeterRegistry registry = new SimpleMeterRegistry();
    when(mongo.count(any(Query.class), eq(WebhookEvent.class))).thenReturn(7L);

    new MetricsConfig(registry).settlementDlqDepthGauge(registry, mongo);

    // The gauge polls the supplier on read.
    assertThat(registry.get(TelemetryMetrics.SETTLEMENT_DLQ_DEPTH).gauge().value()).isEqualTo(7.0);
  }
}
