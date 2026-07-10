package io.hydropark.config;

import io.hydropark.security.InternalClientCertVerifier;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.cert.Certificate;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.List;
import org.apache.catalina.connector.Connector;
import org.apache.coyote.http11.Http11NioProtocol;
import org.apache.tomcat.util.net.SSLHostConfig;
import org.apache.tomcat.util.net.SSLHostConfigCertificate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnExpression;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.web.embedded.tomcat.TomcatServletWebServerFactory;
import org.springframework.boot.web.server.WebServerFactoryCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Server-side wiring for mutual TLS on the internal (api&rarr;issuer / api&rarr;worker) hop
 * (BACKEND-DESIGN §6.2, ticket P1-16.9). Everything here is gated on
 * {@code hydropark.internal.mtls.enabled=true}; with mTLS off (the default) nothing in this class is
 * created and the shared-bearer-token path in {@link InternalHttpConfig} /
 * {@link io.hydropark.security.InternalAuthFilter} is used unchanged.
 *
 * <h2>Why a dedicated connector, not connector-wide {@code clientAuth}</h2>
 *
 * Tomcat's {@code clientAuth} / {@code certificateVerification} is a property of a <b>connector</b>,
 * not of a URL path - it cannot be scoped to only {@code /internal/**}. That is a problem for this
 * fleet because <b>the same image serves all three zones on one port</b>:
 *
 * <ul>
 *   <li>In the combined single-process profile (local dev), one connector on 8080 serves both public
 *       {@code /v1/**} <em>and</em> {@code /internal/**}. Requiring a client cert connector-wide would
 *       break every public API call and turn plain-HTTP dev into HTTPS.
 *   <li>Even in the split deployment, health checks (the Docker {@code HEALTHCHECK} and Fly's checks)
 *       hit the main connector over plain HTTP with no client cert; connector-wide {@code required}
 *       would fail them and the machine would never report healthy.
 * </ul>
 *
 * So mTLS gets its <b>own second connector</b> (default port 8443) that only the api client speaks to
 * over {@code https}. The main plain connector (8080) keeps serving public traffic and health checks
 * untouched. This connector is opened <b>only on zones that actually serve {@code /internal/**}</b>
 * (issuer or worker) - the api zone is a pure mTLS <em>client</em> and needs no inbound listener.
 *
 * <h2>Why {@code certificateVerification="required"} (need), with a filter re-check</h2>
 *
 * The connector is set to "required": the TLS handshake itself demands a client cert and JSSE
 * validates it against our CA truststore, so a certless client or a cert not signed by our CA is
 * rejected at the transport layer (a TLS alert) before any request is dispatched. "required" is used
 * rather than "optional" (want) deliberately: <b>JSSE cannot do optional client-cert auth over TLS
 * 1.3</b> - it requires post-handshake authentication (PHA), which the JSSE TLS 1.3 stack does not
 * implement, so "optional" silently never requests the cert on a TLS 1.3 connection. "required"
 * requests the cert during the handshake and works on TLS 1.2 and 1.3 alike.
 *
 * <p>{@link io.hydropark.security.InternalAuthFilter} additionally re-validates the presented chain
 * against the CA via {@link InternalClientCertVerifier} for every {@code /internal/**} request. That
 * is defense in depth (independent of connector config, and unit-testable), and it is also what
 * rejects a {@code /internal/**} call that arrives on the <em>plain</em> 8080 connector - which
 * carries no client cert - with a clean {@code 403} JSON body, so mTLS can't be bypassed via 8080.
 */
@Configuration
public class InternalMtlsServerConfig {

  private static final Logger log = LoggerFactory.getLogger(InternalMtlsServerConfig.class);

  /**
   * The private CA (loaded from the configured PKCS12 truststore) that {@link InternalAuthFilter}
   * uses to validate presented client certs. Created on any zone with mTLS enabled; only the zones
   * that serve {@code /internal/**} actually consult it.
   */
  @Bean
  @ConditionalOnProperty(name = "hydropark.internal.mtls.enabled", havingValue = "true")
  public InternalClientCertVerifier internalClientCertVerifier(
      @org.springframework.beans.factory.annotation.Value("${hydropark.internal.mtls.truststore-path:}")
          String truststorePath,
      @org.springframework.beans.factory.annotation.Value(
              "${hydropark.internal.mtls.truststore-password:}")
          String truststorePassword) {
    List<X509Certificate> cas = loadCaCerts(truststorePath, truststorePassword);
    log.info(
        "internal mTLS: loaded {} CA certificate(s) from truststore {} for client-cert verification",
        cas.size(),
        truststorePath);
    return new InternalClientCertVerifier(cas);
  }

  /**
   * Adds the dedicated inbound mTLS connector. Gated on mTLS being enabled <b>and</b> this zone
   * serving internal endpoints (issuer or worker) - the api zone never opens it.
   */
  @Bean
  @ConditionalOnExpression(
      "${hydropark.internal.mtls.enabled:false} and "
          + "(${hydropark.issuer.enabled:false} or ${hydropark.worker.enabled:false})")
  public WebServerFactoryCustomizer<TomcatServletWebServerFactory> internalMtlsConnector(
      @org.springframework.beans.factory.annotation.Value("${hydropark.internal.mtls.server-port:8443}")
          int mtlsPort,
      @org.springframework.beans.factory.annotation.Value("${hydropark.internal.mtls.keystore-path:}")
          String keystorePath,
      @org.springframework.beans.factory.annotation.Value(
              "${hydropark.internal.mtls.keystore-password:}")
          String keystorePassword,
      @org.springframework.beans.factory.annotation.Value("${hydropark.internal.mtls.truststore-path:}")
          String truststorePath,
      @org.springframework.beans.factory.annotation.Value(
              "${hydropark.internal.mtls.truststore-password:}")
          String truststorePassword) {
    return factory -> {
      Connector connector =
          buildMtlsConnector(
              mtlsPort, keystorePath, keystorePassword, truststorePath, truststorePassword);
      factory.addAdditionalTomcatConnectors(connector);
      log.info(
          "internal mTLS: added dedicated client-cert connector on port {} (server keystore {},"
              + " CA truststore {}); /internal/** is authenticated by client certificate",
          mtlsPort,
          keystorePath,
          truststorePath);
    };
  }

  private static Connector buildMtlsConnector(
      int port,
      String keystorePath,
      String keystorePassword,
      String truststorePath,
      String truststorePassword) {
    Connector connector = new Connector("org.apache.coyote.http11.Http11NioProtocol");
    connector.setPort(port);
    connector.setScheme("https");
    connector.setSecure(true);

    Http11NioProtocol protocol = (Http11NioProtocol) connector.getProtocolHandler();
    protocol.setSSLEnabled(true);

    SSLHostConfig sslHostConfig = new SSLHostConfig();
    // "required" = the handshake demands a client cert and JSSE validates it against the truststore
    // below; certless or non-CA certs are rejected at the TLS layer. NOT "optional" - JSSE cannot do
    // optional client auth over TLS 1.3 (it needs post-handshake auth, which JSSE lacks), so
    // "optional" would silently never request the cert on a TLS 1.3 connection. InternalAuthFilter
    // re-validates the chain against the CA on top of this (defense in depth + guards the plain-8080
    // /internal path).
    sslHostConfig.setCertificateVerification("required");
    sslHostConfig.setTruststoreFile(resolvePath(truststorePath));
    sslHostConfig.setTruststorePassword(truststorePassword);
    sslHostConfig.setTruststoreType("PKCS12");

    SSLHostConfigCertificate cert =
        new SSLHostConfigCertificate(sslHostConfig, SSLHostConfigCertificate.Type.UNDEFINED);
    cert.setCertificateKeystoreFile(resolvePath(keystorePath));
    cert.setCertificateKeystorePassword(keystorePassword);
    cert.setCertificateKeystoreType("PKCS12");
    sslHostConfig.addCertificate(cert);

    connector.addSslHostConfig(sslHostConfig);
    return connector;
  }

  /** Tomcat resolves relative paths against catalina.base; hand it an absolute path/URL. */
  private static String resolvePath(String path) {
    if (path == null || path.isBlank()) {
      throw new IllegalStateException(
          "internal mTLS is enabled but a keystore/truststore path is blank - run"
              + " deploy/scripts/generate-internal-certs and set the HP_INTERNAL_MTLS_* vars");
    }
    return Path.of(path).toAbsolutePath().toString();
  }

  private static List<X509Certificate> loadCaCerts(String truststorePath, String truststorePassword) {
    if (truststorePath == null || truststorePath.isBlank()) {
      throw new IllegalStateException(
          "internal mTLS is enabled but hydropark.internal.mtls.truststore-path is blank - run"
              + " deploy/scripts/generate-internal-certs and point HP_INTERNAL_MTLS_TRUSTSTORE at"
              + " the generated truststore.p12");
    }
    try {
      KeyStore trust = KeyStore.getInstance("PKCS12");
      char[] pw = truststorePassword == null ? new char[0] : truststorePassword.toCharArray();
      try (InputStream in = Files.newInputStream(Path.of(truststorePath))) {
        trust.load(in, pw);
      }
      List<X509Certificate> cas = new ArrayList<>();
      Enumeration<String> aliases = trust.aliases();
      while (aliases.hasMoreElements()) {
        Certificate c = trust.getCertificate(aliases.nextElement());
        if (c instanceof X509Certificate x509) {
          cas.add(x509);
        }
      }
      if (cas.isEmpty()) {
        throw new IllegalStateException(
            "truststore " + truststorePath + " contains no X.509 CA certificates");
      }
      return cas;
    } catch (IllegalStateException e) {
      throw e;
    } catch (Exception e) {
      throw new IllegalStateException(
          "failed to load internal mTLS CA truststore from " + truststorePath, e);
    }
  }
}
