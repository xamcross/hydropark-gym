package io.hydropark.commerce;

import io.hydropark.common.Uuid7;
import io.hydropark.config.AppProperties;
import io.hydropark.observability.TelemetryMetrics;
import jakarta.servlet.http.HttpServletRequest;
import java.time.Instant;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * §4.8 / N3 - the public, receive-only MoR webhook endpoint. It holds <b>no secret</b> and
 * <b>verifies nothing</b>: it captures the verbatim raw body plus headers into {@code webhook_events}
 * (status {@code received}) and returns 200 fast. The internal settlement worker later verifies the
 * HMAC over these exact bytes before granting anything.
 *
 * <p>The body is read as a {@code byte[]} so Spring never parses it - the bytes must survive verbatim
 * for the worker's constant-time HMAC. A popped public tier can enqueue bytes but cannot forge a
 * <em>verified</em> event, because the forging secret lives only in the worker.
 */
@RestController
@RequestMapping("/v1/webhooks")
@ConditionalOnProperty(name = "hydropark.api.enabled", havingValue = "true", matchIfMissing = true)
public class WebhookController {

  private static final Logger log = LoggerFactory.getLogger(WebhookController.class);

  private final MongoTemplate mongo;
  private final AppProperties props;
  private final TelemetryMetrics metrics;

  public WebhookController(MongoTemplate mongo, AppProperties props, TelemetryMetrics metrics) {
    this.mongo = mongo;
    this.props = props;
    this.metrics = metrics;
  }

  @PostMapping("/mor")
  public ResponseEntity<Void> receive(
      @RequestBody(required = false) byte[] rawBody, HttpServletRequest request) {
    byte[] body = rawBody == null ? new byte[0] : rawBody;
    WebhookEvent event =
        new WebhookEvent(
            Uuid7.generate(),
            props.getPayments().getProvider(),
            body,
            captureHeaders(request),
            Instant.now());
    mongo.insert(event);
    metrics.webhookReceived(); // P1-21.4: hydropark.webhook.received
    log.debug("captured webhook {} ({} bytes) for worker", event.getId(), body.length);
    // Fast ack; verification and grants happen asynchronously in the worker.
    return ResponseEntity.ok().build();
  }

  /** Header names lowercased so providers can look up their signature header case-insensitively. */
  private static Map<String, String> captureHeaders(HttpServletRequest request) {
    Map<String, String> headers = new LinkedHashMap<>();
    for (String name : Collections.list(request.getHeaderNames())) {
      headers.put(name.toLowerCase(), request.getHeader(name));
    }
    return headers;
  }
}
