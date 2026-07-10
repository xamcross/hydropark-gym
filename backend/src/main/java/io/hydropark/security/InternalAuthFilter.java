package io.hydropark.security;

import io.hydropark.config.InternalHttpConfig;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.cert.X509Certificate;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.lang.Nullable;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Guards {@code /internal/**} - the endpoints the issuer and settlement-worker zones expose to the
 * api zone. These paths must never be reachable from the public edge; the Fly apps that host them
 * have no public ingress, and this filter is the second line.
 *
 * <p><b>Two switchable network-auth modes (ticket P1-16.9, BACKEND-DESIGN §6.2).</b>
 *
 * <ul>
 *   <li><b>mTLS off (default).</b> Authentication is the shared bearer secret
 *       ({@code HP_INTERNAL_TOKEN}), compared constant-time. This keeps local dev and every existing
 *       deploy working unchanged until certs are provisioned.
 *   <li><b>mTLS on</b> ({@code hydropark.internal.mtls.enabled=true}). The bearer token is replaced
 *       by a client certificate: the request must carry a peer cert chain
 *       ({@code jakarta.servlet.request.X509Certificate}) that validates against the private CA via
 *       {@link InternalClientCertVerifier}. A request with no cert, or a cert not signed by the CA,
 *       is rejected here even if the connector let it through.
 * </ul>
 *
 * <p>Either way this is a <b>network authentication</b> layer, not an authorization one. It sits
 * <em>above</em> the application-level check that keeps the Issuer safe: the Issuer still
 * independently re-verifies settlement for the exact {@code (user, skill)} on every call
 * (BACKEND-DESIGN §6.2 N3, {@code LocalLicenseIssuer}). mTLS is defense in depth, never a
 * replacement for that re-verification.
 *
 * <p>Comparison of the token is constant-time. A naive {@code equals} on a shared secret leaks its
 * prefix through response timing, which is exactly the sort of thing that survives review because the
 * code "looks right".
 */
@Component
public class InternalAuthFilter extends OncePerRequestFilter {

  /** Servlet attribute the container populates with the validated TLS peer chain (leaf first). */
  static final String X509_ATTRIBUTE = "jakarta.servlet.request.X509Certificate";

  private final byte[] expectedToken;
  private final boolean mtlsEnabled;

  /** Present only when mTLS is enabled; {@code null} in the shared-token path. */
  private final InternalClientCertVerifier certVerifier;

  /**
   * Single constructor for both Spring and unit tests. The {@code certVerifier} is {@code @Nullable}:
   * with mTLS off, {@link InternalMtlsServerConfig} does not create the bean and Spring injects
   * {@code null} here; the shared-token path never touches it.
   */
  @Autowired
  public InternalAuthFilter(
      @Value("${hydropark.internal.token:}") String internalToken,
      @Value("${hydropark.internal.mtls.enabled:false}") boolean mtlsEnabled,
      @Nullable InternalClientCertVerifier certVerifier) {
    this.expectedToken =
        internalToken == null ? new byte[0] : internalToken.getBytes(StandardCharsets.UTF_8);
    this.mtlsEnabled = mtlsEnabled;
    this.certVerifier = certVerifier;
  }

  @Override
  protected boolean shouldNotFilter(HttpServletRequest request) {
    return !request.getRequestURI().startsWith("/internal/");
  }

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws ServletException, IOException {

    boolean authenticated = mtlsEnabled ? clientCertValid(request) : tokenValid(request);
    if (!authenticated) {
      deny(response);
      return;
    }
    chain.doFilter(request, response);
  }

  /** mTLS path: the peer must present a cert chain that validates against our private CA. */
  private boolean clientCertValid(HttpServletRequest request) {
    if (certVerifier == null) {
      // mTLS is enabled but no verifier was wired (missing/empty truststore). Fail closed rather
      // than fall back to the token - a half-configured mTLS must not silently downgrade.
      return false;
    }
    Object attr = request.getAttribute(X509_ATTRIBUTE);
    if (!(attr instanceof X509Certificate[] chain)) {
      return false; // no client certificate presented
    }
    return certVerifier.isTrusted(chain);
  }

  /** Shared-token path (unchanged behaviour). */
  private boolean tokenValid(HttpServletRequest request) {
    String presented = request.getHeader(InternalHttpConfig.INTERNAL_TOKEN_HEADER);
    if (expectedToken.length == 0 || presented == null) {
      return false;
    }
    return MessageDigest.isEqual(expectedToken, presented.getBytes(StandardCharsets.UTF_8));
  }

  private void deny(HttpServletResponse response) throws IOException {
    response.setStatus(403);
    response.setContentType("application/json");
    response.getWriter()
        .write("{\"error\":{\"code\":\"forbidden\",\"message\":\"internal endpoint\",\"details\":{}}}");
  }
}
