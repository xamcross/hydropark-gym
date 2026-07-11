package io.hydropark.config;

import io.hydropark.security.InternalAuthFilter;
import io.hydropark.security.JwtAuthFilter;
import java.util.List;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;

/**
 * Gated on a servlet web application: the one-shot {@code migrate} job runs with
 * {@code spring.main.web-application-type=none}, and an unconditional {@code @EnableWebSecurity}
 * would drag {@code WebSecurityConfiguration} into a context that has no servlet stack at all.
 */
@Configuration
@EnableWebSecurity
@ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
public class SecurityConfig {

  /**
   * The desktop client is a Tauri webview, whose page origin is {@code tauri://localhost} in a
   * packaged build and {@code http://localhost:1420} under `ng serve`. Origins are an explicit
   * allow-list, never {@code *}: credentialed requests carry the bearer token, and a wildcard origin
   * with credentials is both forbidden by the spec and a real leak.
   */
  @Bean
  CorsConfigurationSource corsConfigurationSource(
      @Value("${hydropark.cors.allowed-origins:tauri://localhost,http://localhost:1420}")
          List<String> allowedOrigins) {
    CorsConfiguration config = new CorsConfiguration();
    config.setAllowedOrigins(allowedOrigins);
    config.setAllowedMethods(List.of("GET", "POST", "PATCH", "DELETE", "OPTIONS"));
    config.setAllowedHeaders(
        List.of("Authorization", "Content-Type", "Idempotency-Key", "X-Step-Up-Token"));
    config.setAllowCredentials(true);
    config.setMaxAge(3600L);

    UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
    source.registerCorsConfiguration("/v1/**", config);
    return source;
  }

  @Bean
  SecurityFilterChain filterChain(
      HttpSecurity http, JwtAuthFilter jwtAuthFilter, InternalAuthFilter internalAuthFilter)
      throws Exception {
    http.csrf(csrf -> csrf.disable()) // stateless bearer-token API, no cookies
        .cors(Customizer.withDefaults())
        .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
        .authorizeHttpRequests(
            reg ->
                reg
                    // Public.
                    .requestMatchers("/actuator/health/**", "/actuator/info")
                    .permitAll()
                    // Zone-crossing endpoints. Not public: InternalAuthFilter has already
                    // rejected anything without a valid internal token, and the hosting Fly
                    // apps take no public ingress at all.
                    .requestMatchers("/internal/**")
                    .permitAll()
                    .requestMatchers("/v1/auth/**")
                    .permitAll()
                    // §4.8 - receive-only. Holds no secret, verifies nothing, enqueues raw bytes.
                    .requestMatchers(HttpMethod.POST, "/v1/webhooks/**")
                    .permitAll()
                    // §4.2 - optional auth: anonymous gets the catalog, authed gets `owned` too.
                    .requestMatchers(HttpMethod.GET, "/v1/catalog/**")
                    .permitAll()
                    // P1-19.3: the base model GGUF is a free, unauthenticated download (§8 calls
                    // this a cost risk, not a security one - mitigated by CDN caching and rate
                    // limits, never by gating). NOTE: no handler exists behind this path yet - the
                    // artifact registry / CDN epic (P1-19) is not started, so this currently
                    // permits a route that 404s. Left in place deliberately, and flagged here so it
                    // is not mistaken for an accidentally-exposed endpoint.
                    .requestMatchers(HttpMethod.GET, "/v1/download/model/**")
                    .permitAll()
                    // P1-20 registry submission (POST /v1/registry/**): certify-only, no side
                    // effects, but an internal/admin op — require a valid access token. Tighten to an
                    // admin authority (or relocate under /internal/**, InternalAuthFilter-gated) once
                    // publishing writes exist behind it.
                    .requestMatchers(HttpMethod.POST, "/v1/registry/**")
                    .authenticated()
                    .anyRequest()
                    .authenticated())
        .addFilterBefore(internalAuthFilter, UsernamePasswordAuthenticationFilter.class)
        .addFilterBefore(jwtAuthFilter, UsernamePasswordAuthenticationFilter.class)
        // No form login, no basic auth, no default 302-to-login.
        .formLogin(f -> f.disable())
        .httpBasic(b -> b.disable())
        .logout(l -> l.disable())
        .exceptionHandling(
            e ->
                e.authenticationEntryPoint(
                    (req, res, ex) -> {
                      res.setStatus(401);
                      res.setContentType("application/json");
                      res.getWriter()
                          .write(
                              "{\"error\":{\"code\":\"unauthorized\","
                                  + "\"message\":\"authentication required\",\"details\":{}}}");
                    }));
    return http.build();
  }
}
