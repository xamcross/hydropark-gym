package io.hydropark.observability;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;
import org.springframework.stereotype.Component;

/**
 * P1-21.4 - the single owner of Hydropark's business (money-path) meters. Every meter is registered
 * against the injected Micrometer {@link MeterRegistry} (the one auto-configured by
 * spring-boot-starter-actuator), so it is reported wherever the process exposes metrics.
 *
 * <p>Business counters are bumped by <b>one-line</b> calls at the existing call sites (checkout,
 * settlement worker, webhook edge, license issue) - the money-path services are not otherwise
 * touched. Per-route request latency is captured separately by {@link HttpMetricsInterceptor}
 * (registered in {@link MetricsConfig}); the DLQ-depth gauge is registered there too because it
 * needs the datastore. This class deliberately depends only on the {@link MeterRegistry}.
 *
 * <p>The {@link #CDN_EGRESS_BYTES} counter is registered here so a single canonical meter exists,
 * but incrementing it is left to the CDN/download epic (P1-19) via {@link #addCdnEgressBytes} - this
 * class does not depend on that package.
 */
@Component
public class TelemetryMetrics {

  // Meter names - the single source of truth, referenced by tests and (for egress) other packages.
  public static final String ORDERS_CHECKOUT_STARTED = "hydropark.orders.checkout.started";
  public static final String ORDERS_CHECKOUT_SETTLED = "hydropark.orders.checkout.settled";
  public static final String ORDERS_CHECKOUT_REFUNDED = "hydropark.orders.checkout.refunded";
  public static final String WEBHOOK_RECEIVED = "hydropark.webhook.received";
  public static final String WEBHOOK_SETTLED = "hydropark.webhook.settled";
  public static final String WEBHOOK_DEADLETTERED = "hydropark.webhook.deadlettered";
  public static final String LICENSE_ISSUED = "hydropark.license.issued";
  public static final String LICENSE_ISSUE_LATENCY = "hydropark.license.issue.latency";
  public static final String SETTLEMENT_DLQ_DEPTH = "hydropark.settlement.dlq.depth";

  /**
   * Shared meter name for CDN egress. Declared and registered here so exactly one canonical counter
   * exists; the download agent increments it via {@link #addCdnEgressBytes} without this component
   * ever depending on the CDN package.
   */
  public static final String CDN_EGRESS_BYTES = "hydropark.cdn.egress.bytes";

  private final Counter ordersStarted;
  private final Counter ordersSettled;
  private final Counter ordersRefunded;
  private final Counter webhooksReceived;
  private final Counter webhooksSettled;
  private final Counter webhooksDeadLettered;
  private final Counter licensesIssued;
  private final Timer licenseIssueTimer;
  private final Counter egressBytes;

  public TelemetryMetrics(MeterRegistry registry) {
    this.ordersStarted =
        Counter.builder(ORDERS_CHECKOUT_STARTED)
            .description("Checkouts started (POST /v1/checkout, all kinds)")
            .register(registry);
    this.ordersSettled =
        Counter.builder(ORDERS_CHECKOUT_SETTLED)
            .description("Orders settled by the worker (succeeded webhook)")
            .register(registry);
    this.ordersRefunded =
        Counter.builder(ORDERS_CHECKOUT_REFUNDED)
            .description("Orders reversed by the worker (refunded webhook)")
            .register(registry);
    this.webhooksReceived =
        Counter.builder(WEBHOOK_RECEIVED)
            .description("Raw MoR webhooks captured at the public edge")
            .register(registry);
    this.webhooksSettled =
        Counter.builder(WEBHOOK_SETTLED)
            .description("Webhooks that drove a successful settlement")
            .register(registry);
    this.webhooksDeadLettered =
        Counter.builder(WEBHOOK_DEADLETTERED)
            .description("Webhook events dead-lettered (parked / unverifiable / exhausted)")
            .register(registry);
    this.licensesIssued =
        Counter.builder(LICENSE_ISSUED).description("Licenses issued").register(registry);
    this.licenseIssueTimer =
        Timer.builder(LICENSE_ISSUE_LATENCY)
            .description("Latency of a license issuance")
            .register(registry);
    this.egressBytes =
        Counter.builder(CDN_EGRESS_BYTES)
            .baseUnit("bytes")
            .description("Bytes served from the model/skill CDN (incremented by the download epic)")
            .register(registry);
  }

  /**
   * A metrics instance backed by a throwaway {@link SimpleMeterRegistry}. Used only by the
   * back-compat constructors of the money-path services so their existing unit tests keep
   * compiling; the real bean is always injected with the application's registry.
   */
  public static TelemetryMetrics noop() {
    return new TelemetryMetrics(new SimpleMeterRegistry());
  }

  public void checkoutStarted() {
    ordersStarted.increment();
  }

  public void orderSettled() {
    ordersSettled.increment();
  }

  public void orderRefunded() {
    ordersRefunded.increment();
  }

  public void webhookReceived() {
    webhooksReceived.increment();
  }

  public void webhookSettled() {
    webhooksSettled.increment();
  }

  public void webhookDeadLettered() {
    webhooksDeadLettered.increment();
  }

  public void licenseIssued() {
    licensesIssued.increment();
  }

  /**
   * Times {@code issue} into {@link #LICENSE_ISSUE_LATENCY} and, on success, bumps
   * {@link #LICENSE_ISSUED}. A single call site keeps the controller edit to one line. A thrown
   * issuance is neither timed nor counted (it is not a completed issue).
   */
  public <T> T timeLicenseIssue(Supplier<T> issue) {
    long start = System.nanoTime();
    T result = issue.get();
    licenseIssueTimer.record(System.nanoTime() - start, TimeUnit.NANOSECONDS);
    licensesIssued.increment();
    return result;
  }

  /** Increment the shared CDN egress counter (called by the download epic; declared here). */
  public void addCdnEgressBytes(long bytes) {
    if (bytes > 0) {
      egressBytes.increment(bytes);
    }
  }
}
