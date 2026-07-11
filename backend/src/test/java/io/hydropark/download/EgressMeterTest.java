package io.hydropark.download;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

import io.hydropark.observability.TelemetryMetrics;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.data.mongodb.core.MongoTemplate;

/**
 * The egress meter (P1-19.4): every served download persists a durable {@link EgressSample} and feeds
 * the single canonical {@code hydropark.cdn.egress.bytes} counter owned by {@link TelemetryMetrics}.
 * The Mongo sample is the source of truth, so a zero-byte dev sample still records. Mockito, no Docker.
 */
class EgressMeterTest {

  private final MongoTemplate mongo = mock(MongoTemplate.class);

  @Test
  void persistsSampleAndFeedsTheCanonicalEgressCounter() {
    SimpleMeterRegistry registry = new SimpleMeterRegistry();
    EgressMeter meter = new EgressMeter(mongo, new TelemetryMetrics(registry));

    meter.record("u1", "skill", "skills/cooking/1.2.0/pkg.hpskill", 4096L);

    ArgumentCaptor<EgressSample> saved = ArgumentCaptor.forClass(EgressSample.class);
    verify(mongo).insert(saved.capture());
    EgressSample sample = saved.getValue();
    assertThat(sample.getUserId()).isEqualTo("u1");
    assertThat(sample.getObjectType()).isEqualTo("skill");
    assertThat(sample.getObjectKey()).isEqualTo("skills/cooking/1.2.0/pkg.hpskill");
    assertThat(sample.getBytes()).isEqualTo(4096L);
    assertThat(sample.getServedAt()).isNotNull();

    assertThat(registry.get(TelemetryMetrics.CDN_EGRESS_BYTES).counter().count()).isEqualTo(4096.0);
  }

  @Test
  void zeroByteModelSampleStillPersists() {
    EgressMeter meter = new EgressMeter(mongo, TelemetryMetrics.noop());

    meter.record(null, "model", "models/qwen.gguf", 0L);

    verify(mongo).insert(any(EgressSample.class));
  }
}
