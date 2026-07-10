package io.hydropark.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.InputStream;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * The security-critical assertion for mTLS (ticket P1-16.9): the CA-verification logic accepts a
 * certificate our private CA signed and rejects everything else - a self-signed/rogue cert, an empty
 * chain, and a missing (null) chain.
 *
 * <p>Fixtures under {@code src/test/resources/mtls/} are real certificates generated with openssl
 * (EC P-256): {@code ca.crt} (the private CA), {@code zone-good.crt} (a leaf the CA signed), and
 * {@code rogue.crt} (a self-signed cert with the <em>same</em> CN as the good leaf but which the CA
 * never signed - proving trust is by chain-to-CA, not by matching subject names).
 *
 * <p>Not run by this agent's contract note elsewhere; requires no Docker.
 */
class InternalClientCertVerifierTest {

  private static X509Certificate load(String name) {
    try (InputStream in =
        InternalClientCertVerifierTest.class.getResourceAsStream("/mtls/" + name)) {
      if (in == null) {
        throw new IllegalStateException("missing test fixture /mtls/" + name);
      }
      return (X509Certificate) CertificateFactory.getInstance("X.509").generateCertificate(in);
    } catch (Exception e) {
      throw new IllegalStateException("failed to load fixture " + name, e);
    }
  }

  private InternalClientCertVerifier verifierTrustingOurCa() {
    return new InternalClientCertVerifier(List.of(load("ca.crt")));
  }

  @Test
  void aCertSignedByTheCaPasses() {
    InternalClientCertVerifier verifier = verifierTrustingOurCa();
    assertThat(verifier.isTrusted(new X509Certificate[] {load("zone-good.crt")}))
        .as("a leaf signed by the configured CA must be trusted")
        .isTrue();
  }

  @Test
  void aCertSignedByTheCaPassesEvenWhenTheFullChainIncludesTheCa() {
    // Tomcat usually hands us just the leaf, but a client could present [leaf, CA]. The CA is a
    // trust anchor and must be stripped from the path, not treated as a validation failure.
    InternalClientCertVerifier verifier = verifierTrustingOurCa();
    assertThat(verifier.isTrusted(new X509Certificate[] {load("zone-good.crt"), load("ca.crt")}))
        .isTrue();
  }

  @Test
  void aSelfSignedRogueCertFails() {
    InternalClientCertVerifier verifier = verifierTrustingOurCa();
    assertThat(verifier.isTrusted(new X509Certificate[] {load("rogue.crt")}))
        .as("a self-signed cert not chaining to our CA must be rejected, even with a matching CN")
        .isFalse();
  }

  @Test
  void noCertFails() {
    InternalClientCertVerifier verifier = verifierTrustingOurCa();
    assertThat(verifier.isTrusted(null)).as("null chain (no cert presented) must be rejected")
        .isFalse();
    assertThat(verifier.isTrusted(new X509Certificate[0]))
        .as("empty chain must be rejected")
        .isFalse();
  }

  @Test
  void aChainOfOnlyTheCaItselfFails() {
    // Presenting just the CA cert (no end-entity leaf) must not authenticate as a client.
    InternalClientCertVerifier verifier = verifierTrustingOurCa();
    assertThat(verifier.isTrusted(new X509Certificate[] {load("ca.crt")})).isFalse();
  }

  @Test
  void constructingWithNoCaFailsFast() {
    assertThatThrownBy(() -> new InternalClientCertVerifier(List.of()))
        .isInstanceOf(IllegalArgumentException.class);
  }
}
