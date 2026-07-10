package io.hydropark.config;

import java.time.Duration;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.client.RestClient;

/**
 * Client used for api -> issuer / api -> worker calls across trust zones.
 *
 * <p>Authentication here is a shared bearer secret ({@code HP_INTERNAL_TOKEN}) presented on a
 * network that has no public ingress. BACKEND-DESIGN §6.2 specifies <b>mTLS</b> for these hops. The
 * shared secret is weaker: it is a bearer credential, so anything that can read the api zone's
 * environment can call the Issuer as the api zone. That is tolerable only because the Issuer
 * re-verifies settlement for the exact (user, skill) on every request and therefore cannot be made
 * to sign an unowned skill by a caller who merely holds this token. Replacing it with mTLS is
 * tracked alongside P1-16.8 and should land before paid acquisition.
 */
@Configuration
public class InternalHttpConfig {

  public static final String INTERNAL_TOKEN_HEADER = "X-Internal-Token";

  /**
   * Built from Spring Boot's auto-configured {@link RestClient.Builder}, <b>not</b> a bare
   * {@code RestClient.builder()}.
   *
   * <p>This matters more than it looks. A bare builder installs its own default
   * {@code ObjectMapper}, which ignores the application's
   * {@code spring.jackson.property-naming-strategy=SNAKE_CASE}. The api zone would then serialize
   * {@code skillId} while the issuer zone - using Boot's mapper - deserializes {@code skill_id},
   * silently binding every field to null. The call still returns 200-shaped traffic and the Issuer
   * dutifully refuses to sign a license for a null skill. Sharing the container's converters keeps
   * both ends of the internal hop on one wire format by construction.
   */
  @Bean("internalRestClient")
  RestClient internalRestClient(
      RestClient.Builder builder, @Value("${hydropark.internal.token:}") String internalToken) {

    // The issuer scales to zero. Waking a suspended Fly machine through the proxy takes ~9-11s
    // (measured), and the connection that triggers the wake is itself dropped. A 3s connect timeout
    // guaranteed that the first license request after any idle period failed.
    SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
    factory.setConnectTimeout(Duration.ofSeconds(15));
    factory.setReadTimeout(Duration.ofSeconds(30));

    // Retrying happens at the call site (io.hydropark.common.InternalRetry), NOT in a
    // ClientHttpRequestInterceptor. A cold wake fails while the response body is being extracted -
    // "SocketException: Unexpected end of file from server" - which is after execution.execute()
    // has already returned, and therefore invisible to an interceptor.
    return builder
        .requestFactory(factory)
        .defaultHeader(INTERNAL_TOKEN_HEADER, internalToken)
        .build();
  }
}
