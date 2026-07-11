package io.hydropark.observability;

import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.servlet.HandlerMapping;

/**
 * P1-21.4 - records per-route request latency into a Micrometer {@link Timer}, so the money-path
 * services do not have to be instrumented by hand. Registered in {@link MetricsConfig#addInterceptors}.
 *
 * <p>The {@code uri} tag is the <b>matched route pattern</b> ({@code /v1/orders/{id}}), never the raw
 * request URI, so an unbounded path variable cannot explode the metric's cardinality. Requests that
 * matched no handler (a 404) are folded into {@code UNKNOWN} for the same reason.
 */
public class HttpMetricsInterceptor implements HandlerInterceptor {

  static final String TIMER = "hydropark.http.server.requests";
  private static final String SAMPLE_ATTR = HttpMetricsInterceptor.class.getName() + ".SAMPLE";

  private final MeterRegistry registry;

  public HttpMetricsInterceptor(MeterRegistry registry) {
    this.registry = registry;
  }

  @Override
  public boolean preHandle(
      HttpServletRequest request, HttpServletResponse response, Object handler) {
    request.setAttribute(SAMPLE_ATTR, Timer.start(registry));
    return true;
  }

  @Override
  public void afterCompletion(
      HttpServletRequest request, HttpServletResponse response, Object handler, Exception ex) {
    Object attr = request.getAttribute(SAMPLE_ATTR);
    if (!(attr instanceof Timer.Sample sample)) {
      return; // preHandle did not run (e.g. an earlier interceptor short-circuited)
    }
    int status = response.getStatus();
    sample.stop(
        Timer.builder(TIMER)
            .description("Per-route HTTP server request latency")
            .tag("method", request.getMethod())
            .tag("uri", route(request))
            .tag("status", Integer.toString(status))
            .tag("outcome", outcome(status))
            .register(registry));
  }

  /** The matched route pattern, or {@code UNKNOWN} when no handler matched (bounds cardinality). */
  private static String route(HttpServletRequest request) {
    Object best = request.getAttribute(HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE);
    return best != null ? best.toString() : "UNKNOWN";
  }

  private static String outcome(int status) {
    if (status < 200) {
      return "INFORMATIONAL";
    }
    if (status < 300) {
      return "SUCCESS";
    }
    if (status < 400) {
      return "REDIRECTION";
    }
    if (status < 500) {
      return "CLIENT_ERROR";
    }
    return "SERVER_ERROR";
  }
}
