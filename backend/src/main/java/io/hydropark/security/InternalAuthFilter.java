package io.hydropark.security;

import io.hydropark.config.InternalHttpConfig;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Guards {@code /internal/**} - the endpoints the issuer and settlement-worker zones expose to the
 * api zone. These paths must never be reachable from the public edge; the Fly apps that host them
 * have no public ingress, and this filter is the second line.
 *
 * <p>Comparison is constant-time. A naive {@code equals} on a shared secret leaks its prefix through
 * response timing, which is exactly the sort of thing that survives review because the code "looks
 * right".
 */
@Component
public class InternalAuthFilter extends OncePerRequestFilter {

  private final byte[] expected;

  public InternalAuthFilter(@Value("${hydropark.internal.token:}") String internalToken) {
    this.expected = internalToken == null ? new byte[0] : internalToken.getBytes(StandardCharsets.UTF_8);
  }

  @Override
  protected boolean shouldNotFilter(HttpServletRequest request) {
    return !request.getRequestURI().startsWith("/internal/");
  }

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws ServletException, IOException {

    String presented = request.getHeader(InternalHttpConfig.INTERNAL_TOKEN_HEADER);
    if (expected.length == 0 || presented == null) {
      deny(response);
      return;
    }
    if (!MessageDigest.isEqual(expected, presented.getBytes(StandardCharsets.UTF_8))) {
      deny(response);
      return;
    }
    chain.doFilter(request, response);
  }

  private void deny(HttpServletResponse response) throws IOException {
    response.setStatus(403);
    response.setContentType("application/json");
    response.getWriter()
        .write("{\"error\":{\"code\":\"forbidden\",\"message\":\"internal endpoint\",\"details\":{}}}");
  }
}
