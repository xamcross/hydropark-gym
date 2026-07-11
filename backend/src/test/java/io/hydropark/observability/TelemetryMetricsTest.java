package io.hydropark.observability;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;

/**
 * P1-21.4 - every business meter must register against a real Micrometer registry and count. Runs
 * headlessly over a {@link SimpleMeterRegistry}; no Mongo/Docker.
 */
class TelemetryMetricsTest {

  @Test
  void allMetersRegisterAgainstTheRegistry() {
    SimpleMeterRegistry registry = new SimpleMeterRegistry();
    new TelemetryMetrics(registry);

    // Each name resolves to a registered meter (get(...) throws if absent).
    assertThat(registry.get(TelemetryMetrics.ORDERS_CHECKOUT_STARTED).counter()).isNotNull();
    assertThat(registry.get(TelemetryMetrics.ORDERS_CHECKOUT_SETTLED).counter()).isNotNull();
    assertThat(registry.get(TelemetryMetrics.ORDERS_CHECKOUT_REFUNDED).counter()).isNotNull();
    assertThat(registry.get(TelemetryMetrics.WEBHOOK_RECEIVED).counter()).isNotNull();
    assertThat(registry.get(TelemetryMetrics.WEBHOOK_SETTLED).counter()).isNotNull();
    assertThat(registry.get(TelemetryMetrics.WEBHOOK_DEADLETTERED).counter()).isNotNull();
    assertThat(registry.get(TelemetryMetrics.LICENSE_ISSUED).counter()).isNotNull();
    assertThat(registry.get(TelemetryMetrics.LICENSE_ISSUE_LATENCY).timer()).isNotNull();
    assertThat(registry.get(TelemetryMetrics.CDN_EGRESS_BYTES).counter()).isNotNull();
  }

  @Test
  void countersIncrement() {
    SimpleMeterRegistry registry = new SimpleMeterRegistry();
    TelemetryMetrics metrics = new TelemetryMetrics(registry);

    metrics.checkoutStarted();
    metrics.orderSettled();
    metrics.orderSettled();
    metrics.orderRefunded();
    metrics.webhookReceived();
    metrics.webhookSettled();
    metrics.webhookDeadLettered();
    metrics.licenseIssued();

    assertThat(registry.get(TelemetryMetrics.ORDERS_CHECKOUT_STARTED).counter().count()).isEqualTo(1.0);
    assertThat(registry.get(TelemetryMetrics.ORDERS_CHECKOUT_SETTLED).counter().count()).isEqualTo(2.0);
    assertThat(registry.get(TelemetryMetrics.ORDERS_CHECKOUT_REFUNDED).counter().count()).isEqualTo(1.0);
    assertThat(registry.get(TelemetryMetrics.WEBHOOK_RECEIVED).counter().count()).isEqualTo(1.0);
    assertThat(registry.get(TelemetryMetrics.WEBHOOK_SETTLED).counter().count()).isEqualTo(1.0);
    assertThat(registry.get(TelemetryMetrics.WEBHOOK_DEADLETTERED).counter().count()).isEqualTo(1.0);
    assertThat(registry.get(TelemetryMetrics.LICENSE_ISSUED).counter().count()).isEqualTo(1.0);
  }

  @Test
  void egressCounterAccumulatesBytesAndIgnoresNonPositive() {
    SimpleMeterRegistry registry = new SimpleMeterRegistry();
    TelemetryMetrics metrics = new TelemetryMetrics(registry);

    metrics.addCdnEgressBytes(1_000L);
    metrics.addCdnEgressBytes(500L);
    metrics.addCdnEgressBytes(0L); // ignored
    metrics.addCdnEgressBytes(-7L); // ignored

    assertThat(registry.get(TelemetryMetrics.CDN_EGRESS_BYTES).counter().count()).isEqualTo(1_500.0);
  }

  @Test
  void timeLicenseIssueRecordsLatencyAndCountsOnSuccess() {
    SimpleMeterRegistry registry = new SimpleMeterRegistry();
    TelemetryMetrics metrics = new TelemetryMetrics(registry);

    String result = metrics.timeLicenseIssue(() -> "lic-token");

    assertThat(result).isEqualTo("lic-token");
    assertThat(registry.get(TelemetryMetrics.LICENSE_ISSUE_LATENCY).timer().count()).isEqualTo(1L);
    assertThat(registry.get(TelemetryMetrics.LICENSE_ISSUE_LATENCY).timer().totalTime(TimeUnit.NANOSECONDS))
        .isGreaterThanOrEqualTo(0.0);
    assertThat(registry.get(TelemetryMetrics.LICENSE_ISSUED).counter().count()).isEqualTo(1.0);
  }

  @Test
  void timeLicenseIssueDoesNotCountAFailedIssue() {
    SimpleMeterRegistry registry = new SimpleMeterRegistry();
    TelemetryMetrics metrics = new TelemetryMetrics(registry);

    assertThatThrownBy(
            () ->
                metrics.timeLicenseIssue(
                    () -> {
                      throw new IllegalStateException("boom");
                    }))
        .isInstanceOf(IllegalStateException.class);

    // A thrown issuance is neither timed nor counted.
    assertThat(registry.get(TelemetryMetrics.LICENSE_ISSUE_LATENCY).timer().count()).isEqualTo(0L);
    assertThat(registry.get(TelemetryMetrics.LICENSE_ISSUED).counter().count()).isEqualTo(0.0);
  }

  @Test
  void noopIsUsableAndBacksAThrowawayRegistry() {
    TelemetryMetrics metrics = TelemetryMetrics.noop();
    // Must not throw - the back-compat constructors of the money-path services rely on this.
    metrics.checkoutStarted();
    metrics.webhookDeadLettered();
    metrics.addCdnEgressBytes(10L);
  }
}
