package io.hydropark.download;

import io.hydropark.common.Uuid7;
import io.hydropark.observability.TelemetryMetrics;
import java.time.Instant;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.stereotype.Component;

/**
 * Records CDN egress per served download (P1-19.4) so the gross-margin gate can later weigh delivery
 * cost against revenue. Every call persists a durable {@link EgressSample} (queryable/aggregatable
 * over any window - the source of truth the margin gate reads) and bumps the single canonical
 * {@code hydropark.cdn.egress.bytes} counter through {@link TelemetryMetrics#addCdnEgressBytes}.
 *
 * <p>The counter is deliberately <em>not</em> re-registered here: {@link TelemetryMetrics} owns it
 * (P1-21.4) so exactly one meter of that name exists, and this epic is its declared incrementer.
 */
@Component
public class EgressMeter {

  private final MongoTemplate mongo;
  private final TelemetryMetrics metrics;

  public EgressMeter(MongoTemplate mongo, TelemetryMetrics metrics) {
    this.mongo = mongo;
    this.metrics = metrics;
  }

  /**
   * @param userId the buyer for a skill pull, or {@code null} for a public model pull
   * @param objectType {@code skill} | {@code model}
   * @param bytes the served object's size; 0 when the dev store has no real bytes to weigh
   */
  public void record(String userId, String objectType, String objectKey, long bytes) {
    mongo.insert(
        EgressSample.create(Uuid7.generate(), userId, objectType, objectKey, bytes, Instant.now()));
    metrics.addCdnEgressBytes(bytes);
  }
}
