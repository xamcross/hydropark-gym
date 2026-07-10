package io.hydropark.security;

import java.security.cert.CertPath;
import java.security.cert.CertPathValidator;
import java.security.cert.CertificateFactory;
import java.security.cert.PKIXParameters;
import java.security.cert.TrustAnchor;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Validates a client certificate chain presented on the internal (api&rarr;issuer / api&rarr;worker)
 * mTLS hop against a small private CA (BACKEND-DESIGN §6.2, ticket P1-16.9).
 *
 * <p>This is the <b>security-critical</b> half of mTLS: it answers "was this certificate signed by
 * <em>our</em> CA?" and nothing weaker. It performs a full PKIX path validation against the
 * configured trust anchor(s), so a self-signed / rogue cert (which does not chain to the CA), an
 * empty chain, and a null chain all return {@code false}. There is no fallback to comparing subject
 * DNs or fingerprints - a matching CN on a cert the CA never signed must not pass.
 *
 * <p>The class is deliberately transport-agnostic and dependency-free: it takes the CA certificates
 * directly, so the assertion "CA-signed passes, rogue fails, no cert fails" is unit-testable without
 * standing up Tomcat. {@link io.hydropark.config.InternalMtlsServerConfig} builds the Spring bean
 * from the configured PKCS12 truststore; {@link InternalAuthFilter} calls {@link #isTrusted} for
 * {@code /internal/**} requests when mTLS is enabled.
 *
 * <p><b>Fail closed.</b> Every failure mode - malformed chain, validation error, missing anchors -
 * returns {@code false}; nothing throws out of {@link #isTrusted}. A network authentication check
 * that leaks an exception is a check that can be turned into an allow by a crafted input.
 *
 * <p>Revocation (CRL/OCSP) is disabled: this is a closed internal PKI with a handful of long-lived
 * zone certs and no distribution point. Compromise response is CA rotation, not revocation lists.
 */
public final class InternalClientCertVerifier {

  private final Set<TrustAnchor> anchors;

  /**
   * @param caCerts the trusted CA certificate(s); at least one is required. mTLS being enabled with
   *     no CA configured is a misconfiguration, not a reason to trust everything, so it fails fast at
   *     construction rather than silently accepting any cert later.
   */
  public InternalClientCertVerifier(Collection<X509Certificate> caCerts) {
    if (caCerts == null || caCerts.isEmpty()) {
      throw new IllegalArgumentException(
          "mTLS is enabled but no CA certificate was configured for client-cert verification");
    }
    Set<TrustAnchor> built = new HashSet<>();
    for (X509Certificate ca : caCerts) {
      built.add(new TrustAnchor(ca, null));
    }
    this.anchors = Set.copyOf(built);
  }

  /**
   * @param chain the peer certificate chain as populated by the TLS layer (leaf first), i.e. the
   *     servlet request attribute {@code jakarta.servlet.request.X509Certificate}.
   * @return {@code true} iff the leaf validates to one of the configured CA anchors under PKIX.
   */
  public boolean isTrusted(X509Certificate[] chain) {
    if (chain == null || chain.length == 0) {
      return false;
    }
    try {
      // A trust anchor must not also appear inside the CertPath, or PKIX rejects the path. Tomcat
      // usually hands us just the leaf, but be defensive if the full chain (leaf..CA) is presented.
      List<X509Certificate> path = new ArrayList<>(chain.length);
      for (X509Certificate c : chain) {
        boolean isAnchor = anchors.stream().anyMatch(a -> a.getTrustedCert().equals(c));
        if (!isAnchor) {
          path.add(c);
        }
      }
      if (path.isEmpty()) {
        return false;
      }
      CertificateFactory cf = CertificateFactory.getInstance("X.509");
      CertPath certPath = cf.generateCertPath(path);

      PKIXParameters params = new PKIXParameters(anchors);
      params.setRevocationEnabled(false);

      CertPathValidator.getInstance("PKIX").validate(certPath, params);
      return true;
    } catch (Exception e) {
      // Fail closed: any validation failure or malformed input is untrusted.
      return false;
    }
  }
}
