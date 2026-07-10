package io.hydropark.security;

import static org.assertj.core.api.Assertions.assertThat;

import io.hydropark.config.InternalHttpConfig;
import java.io.InputStream;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

/**
 * Exercises {@link InternalAuthFilter}'s two switchable modes end-to-end at the servlet level
 * (ticket P1-16.9), using {@code MockHttpServletRequest} to stand in for what Tomcat populates.
 *
 * <ul>
 *   <li>mTLS ON: {@code /internal/**} is authorized iff a CA-signed client cert is on the request;
 *       no cert and a rogue cert are both rejected 403.
 *   <li>mTLS OFF: the original shared-token behaviour is preserved exactly.
 *   <li>Non-{@code /internal} paths are never touched in either mode.
 * </ul>
 */
class InternalAuthFilterMtlsTest {

  private static final String TOKEN = "s3cret-internal-token";

  private static X509Certificate load(String name) {
    try (InputStream in = InternalAuthFilterMtlsTest.class.getResourceAsStream("/mtls/" + name)) {
      if (in == null) {
        throw new IllegalStateException("missing test fixture /mtls/" + name);
      }
      return (X509Certificate) CertificateFactory.getInstance("X.509").generateCertificate(in);
    } catch (Exception e) {
      throw new IllegalStateException("failed to load fixture " + name, e);
    }
  }

  private static InternalAuthFilter mtlsFilter() {
    InternalClientCertVerifier verifier = new InternalClientCertVerifier(List.of(load("ca.crt")));
    return new InternalAuthFilter(TOKEN, true, verifier);
  }

  private static InternalAuthFilter tokenFilter() {
    return new InternalAuthFilter(TOKEN, false, null);
  }

  private static MockHttpServletRequest internalRequest() {
    MockHttpServletRequest req = new MockHttpServletRequest("POST", "/internal/licenses/issue");
    req.setRequestURI("/internal/licenses/issue");
    return req;
  }

  private static boolean passedThrough(MockFilterChain chain) {
    return chain.getRequest() != null; // the downstream got the request => filter allowed it
  }

  // --- mTLS ON --------------------------------------------------------------

  @Test
  void mtls_validClientCert_isAllowed() throws Exception {
    MockHttpServletRequest req = internalRequest();
    req.setAttribute(
        InternalAuthFilter.X509_ATTRIBUTE, new X509Certificate[] {load("zone-good.crt")});
    MockHttpServletResponse res = new MockHttpServletResponse();
    MockFilterChain chain = new MockFilterChain();

    mtlsFilter().doFilter(req, res, chain);

    assertThat(passedThrough(chain)).as("CA-signed client cert must pass").isTrue();
    assertThat(res.getStatus()).isEqualTo(200);
  }

  @Test
  void mtls_noClientCert_isRejected() throws Exception {
    MockHttpServletRequest req = internalRequest(); // no X509 attribute set
    MockHttpServletResponse res = new MockHttpServletResponse();
    MockFilterChain chain = new MockFilterChain();

    mtlsFilter().doFilter(req, res, chain);

    assertThat(passedThrough(chain)).as("a certless internal call must be rejected").isFalse();
    assertThat(res.getStatus()).isEqualTo(403);
  }

  @Test
  void mtls_rogueClientCert_isRejected() throws Exception {
    MockHttpServletRequest req = internalRequest();
    req.setAttribute(InternalAuthFilter.X509_ATTRIBUTE, new X509Certificate[] {load("rogue.crt")});
    MockHttpServletResponse res = new MockHttpServletResponse();
    MockFilterChain chain = new MockFilterChain();

    mtlsFilter().doFilter(req, res, chain);

    assertThat(passedThrough(chain)).as("a cert not signed by our CA must be rejected").isFalse();
    assertThat(res.getStatus()).isEqualTo(403);
  }

  @Test
  void mtls_aValidTokenDoesNotSubstituteForACert() throws Exception {
    // Under mTLS the token is no longer the authenticator: presenting only the (correct) token,
    // with no client cert, must still be rejected.
    MockHttpServletRequest req = internalRequest();
    req.addHeader(InternalHttpConfig.INTERNAL_TOKEN_HEADER, TOKEN);
    MockHttpServletResponse res = new MockHttpServletResponse();
    MockFilterChain chain = new MockFilterChain();

    mtlsFilter().doFilter(req, res, chain);

    assertThat(passedThrough(chain)).isFalse();
    assertThat(res.getStatus()).isEqualTo(403);
  }

  // --- mTLS OFF (unchanged shared-token behaviour) --------------------------

  @Test
  void token_correctToken_isAllowed() throws Exception {
    MockHttpServletRequest req = internalRequest();
    req.addHeader(InternalHttpConfig.INTERNAL_TOKEN_HEADER, TOKEN);
    MockHttpServletResponse res = new MockHttpServletResponse();
    MockFilterChain chain = new MockFilterChain();

    tokenFilter().doFilter(req, res, chain);

    assertThat(passedThrough(chain)).isTrue();
    assertThat(res.getStatus()).isEqualTo(200);
  }

  @Test
  void token_missingToken_isRejected() throws Exception {
    MockHttpServletRequest req = internalRequest();
    MockHttpServletResponse res = new MockHttpServletResponse();
    MockFilterChain chain = new MockFilterChain();

    tokenFilter().doFilter(req, res, chain);

    assertThat(passedThrough(chain)).isFalse();
    assertThat(res.getStatus()).isEqualTo(403);
  }

  @Test
  void token_wrongToken_isRejected() throws Exception {
    MockHttpServletRequest req = internalRequest();
    req.addHeader(InternalHttpConfig.INTERNAL_TOKEN_HEADER, "not-the-token");
    MockHttpServletResponse res = new MockHttpServletResponse();
    MockFilterChain chain = new MockFilterChain();

    tokenFilter().doFilter(req, res, chain);

    assertThat(passedThrough(chain)).isFalse();
    assertThat(res.getStatus()).isEqualTo(403);
  }

  @Test
  void token_underMtlsOff_aClientCertIsIgnored() throws Exception {
    // With mTLS off, a client cert on the request is irrelevant; only the token authenticates.
    MockHttpServletRequest req = internalRequest();
    req.setAttribute(
        InternalAuthFilter.X509_ATTRIBUTE, new X509Certificate[] {load("zone-good.crt")});
    MockHttpServletResponse res = new MockHttpServletResponse();
    MockFilterChain chain = new MockFilterChain();

    tokenFilter().doFilter(req, res, chain); // no token header

    assertThat(passedThrough(chain)).as("a cert must not authenticate when mTLS is off").isFalse();
    assertThat(res.getStatus()).isEqualTo(403);
  }

  // --- path scoping ---------------------------------------------------------

  @Test
  void nonInternalPath_isNeverFiltered() throws Exception {
    MockHttpServletRequest req = new MockHttpServletRequest("GET", "/v1/catalog");
    req.setRequestURI("/v1/catalog");
    MockHttpServletResponse res = new MockHttpServletResponse();
    MockFilterChain chain = new MockFilterChain();

    mtlsFilter().doFilter(req, res, chain); // no cert, but path is public

    assertThat(passedThrough(chain)).as("/v1/** must bypass the internal filter entirely").isTrue();
    assertThat(res.getStatus()).isEqualTo(200);
  }
}
