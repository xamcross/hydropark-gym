package io.hydropark.security;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.hydropark.common.ApiError;
import io.hydropark.common.ApiException;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.Map;
import org.springframework.http.MediaType;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Populates the security context from a bearer token when one is present.
 *
 * <p>A <em>missing</em> token is not an error here - the catalog endpoints authenticate optionally
 * (§4.2: an authed caller gets {@code owned} annotations, an anonymous one still gets the catalog).
 * Authorization is enforced by the filter chain and by {@link CurrentUser#require()}. A
 * <em>malformed or expired</em> token, by contrast, is always rejected: silently treating it as
 * anonymous would let an expired session quietly downgrade instead of prompting a refresh.
 */
@Component
public class JwtAuthFilter extends OncePerRequestFilter {

  private static final String BEARER = "Bearer ";

  private final AccessTokenService tokens;
  private final ObjectMapper mapper;

  public JwtAuthFilter(AccessTokenService tokens, ObjectMapper mapper) {
    this.tokens = tokens;
    this.mapper = mapper;
  }

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws ServletException, IOException {

    String header = request.getHeader("Authorization");
    if (header != null && header.startsWith(BEARER)) {
      String token = header.substring(BEARER.length()).trim();
      try {
        SecurityContextHolder.getContext().setAuthentication(tokens.verify(token));
      } catch (ApiException e) {
        SecurityContextHolder.clearContext();
        writeError(response, e);
        return;
      }
    }
    chain.doFilter(request, response);
  }

  private void writeError(HttpServletResponse response, ApiException e) throws IOException {
    response.setStatus(e.errorCode().status().value());
    response.setContentType(MediaType.APPLICATION_JSON_VALUE);
    mapper.writeValue(
        response.getOutputStream(), ApiError.of(e.errorCode(), e.getMessage(), Map.of()));
  }
}
