package io.hydropark.observability;

import static org.assertj.core.api.Assertions.assertThat;

import io.micrometer.core.instrument.Timer;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.web.servlet.HandlerMapping;

/**
 * P1-21.4 - the per-route latency interceptor tags by the matched <b>pattern</b> (not the raw URI),
 * so a path variable cannot explode cardinality. Headless: no servlet container, mock request/response.
 */
class HttpMetricsInterceptorTest {

  @Test
  void recordsLatencyTaggedByMatchedRoutePattern() {
    SimpleMeterRegistry registry = new SimpleMeterRegistry();
    HttpMetricsInterceptor interceptor = new HttpMetricsInterceptor(registry);

    MockHttpServletRequest request = new MockHttpServletRequest("GET", "/v1/orders/abc123");
    request.setAttribute(HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE, "/v1/orders/{id}");
    MockHttpServletResponse response = new MockHttpServletResponse();
    response.setStatus(200);

    interceptor.preHandle(request, response, new Object());
    interceptor.afterCompletion(request, response, new Object(), null);

    Timer timer =
        registry
            .get(HttpMetricsInterceptor.TIMER)
            .tag("method", "GET")
            .tag("uri", "/v1/orders/{id}")
            .tag("status", "200")
            .tag("outcome", "SUCCESS")
            .timer();
    assertThat(timer.count()).isEqualTo(1L);
  }

  @Test
  void foldsAnUnmatchedRequestIntoUnknownRoute() {
    SimpleMeterRegistry registry = new SimpleMeterRegistry();
    HttpMetricsInterceptor interceptor = new HttpMetricsInterceptor(registry);

    // No BEST_MATCHING_PATTERN_ATTRIBUTE -> nothing matched (a 404).
    MockHttpServletRequest request = new MockHttpServletRequest("POST", "/nope/deadbeef");
    MockHttpServletResponse response = new MockHttpServletResponse();
    response.setStatus(404);

    interceptor.preHandle(request, response, new Object());
    interceptor.afterCompletion(request, response, new Object(), null);

    Timer timer =
        registry
            .get(HttpMetricsInterceptor.TIMER)
            .tag("uri", "UNKNOWN")
            .tag("status", "404")
            .tag("outcome", "CLIENT_ERROR")
            .timer();
    assertThat(timer.count()).isEqualTo(1L);
  }

  @Test
  void afterCompletionWithoutPreHandleIsANoOp() {
    SimpleMeterRegistry registry = new SimpleMeterRegistry();
    HttpMetricsInterceptor interceptor = new HttpMetricsInterceptor(registry);

    MockHttpServletRequest request = new MockHttpServletRequest("GET", "/v1/whatever");
    MockHttpServletResponse response = new MockHttpServletResponse();

    // No sample stamped: must not throw and must not register the timer.
    interceptor.afterCompletion(request, response, new Object(), null);

    assertThat(registry.find(HttpMetricsInterceptor.TIMER).timer()).isNull();
  }
}
