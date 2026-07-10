package io.hydropark.config;

import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.time.Duration;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManagerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.client.RestClient;

/**
 * Client used for api -&gt; issuer / api -&gt; worker calls across trust zones.
 *
 * <p><b>Two switchable authentication modes (ticket P1-16.9, BACKEND-DESIGN §6.2).</b>
 *
 * <ul>
 *   <li><b>mTLS off (default).</b> Authentication is a shared bearer secret
 *       ({@code HP_INTERNAL_TOKEN}) presented on a network that has no public ingress. This is the
 *       original path and is left exactly as-is so local dev and existing deploys keep working.
 *   <li><b>mTLS on</b> ({@code hydropark.internal.mtls.enabled=true}). The bearer token is replaced
 *       by mutual TLS: this client presents the api zone's client certificate (from its PKCS12
 *       keystore) and verifies the issuer/worker server cert against the private CA truststore. The
 *       {@code HP_ISSUER_URL} / {@code HP_WORKER_URL} become {@code https://...} on the dedicated mTLS
 *       port (see {@link InternalMtlsServerConfig}).
 * </ul>
 *
 * <p>Either mode is only a <b>network</b> credential, never authorization: the Issuer re-verifies
 * settlement for the exact {@code (user, skill)} on every request regardless (§6.2 N3), so this
 * client cannot be turned into a signing oracle for an unowned skill. mTLS is defense in depth
 * layered <em>over</em> that check, not a replacement for it.
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
      RestClient.Builder builder,
      @Value("${hydropark.internal.token:}") String internalToken,
      @Value("${hydropark.internal.mtls.enabled:false}") boolean mtlsEnabled,
      @Value("${hydropark.internal.mtls.keystore-path:}") String keystorePath,
      @Value("${hydropark.internal.mtls.keystore-password:}") String keystorePassword,
      @Value("${hydropark.internal.mtls.truststore-path:}") String truststorePath,
      @Value("${hydropark.internal.mtls.truststore-password:}") String truststorePassword) {

    // The issuer scales to zero. Waking a suspended Fly machine through the proxy takes ~9-11s
    // (measured), and the connection that triggers the wake is itself dropped. A 3s connect timeout
    // guaranteed that the first license request after any idle period failed.
    SimpleClientHttpRequestFactory factory =
        mtlsEnabled
            ? mtlsRequestFactory(
                keystorePath, keystorePassword, truststorePath, truststorePassword)
            : new SimpleClientHttpRequestFactory();
    factory.setConnectTimeout(Duration.ofSeconds(15));
    factory.setReadTimeout(Duration.ofSeconds(30));

    // Retrying happens at the call site (io.hydropark.common.InternalRetry), NOT in a
    // ClientHttpRequestInterceptor. A cold wake fails while the response body is being extracted -
    // "SocketException: Unexpected end of file from server" - which is after execution.execute()
    // has already returned, and therefore invisible to an interceptor.
    //
    // The X-Internal-Token header is still presented under mTLS. It is harmless (the server ignores
    // it once mTLS is on) and keeps a single client code path; mTLS replaces the token as the
    // *server-side* authenticator, it does not require the client to stop sending it.
    return builder
        .requestFactory(factory)
        .defaultHeader(INTERNAL_TOKEN_HEADER, internalToken)
        .build();
  }

  /**
   * A {@link SimpleClientHttpRequestFactory} that installs a client-cert-presenting
   * {@link SSLSocketFactory} on each outbound {@code HttpsURLConnection}. Default hostname
   * verification is left ON: the internal server certs carry the zone DNS names as SANs (see
   * {@code deploy/scripts/generate-internal-certs}), so {@code https://issuer:8443} verifies.
   */
  private static SimpleClientHttpRequestFactory mtlsRequestFactory(
      String keystorePath,
      String keystorePassword,
      String truststorePath,
      String truststorePassword) {
    SSLContext sslContext =
        buildClientSslContext(keystorePath, keystorePassword, truststorePath, truststorePassword);
    final SSLSocketFactory socketFactory = sslContext.getSocketFactory();
    return new SimpleClientHttpRequestFactory() {
      @Override
      protected void prepareConnection(HttpURLConnection connection, String httpMethod)
          throws IOException {
        if (connection instanceof HttpsURLConnection https) {
          https.setSSLSocketFactory(socketFactory);
        }
        super.prepareConnection(connection, httpMethod);
      }
    };
  }

  private static SSLContext buildClientSslContext(
      String keystorePath,
      String keystorePassword,
      String truststorePath,
      String truststorePassword) {
    if (keystorePath == null || keystorePath.isBlank()) {
      throw new IllegalStateException(
          "internal mTLS is enabled but hydropark.internal.mtls.keystore-path is blank - the api"
              + " zone needs its client cert; run deploy/scripts/generate-internal-certs and set"
              + " HP_INTERNAL_MTLS_KEYSTORE");
    }
    if (truststorePath == null || truststorePath.isBlank()) {
      throw new IllegalStateException(
          "internal mTLS is enabled but hydropark.internal.mtls.truststore-path is blank - set"
              + " HP_INTERNAL_MTLS_TRUSTSTORE to the generated truststore.p12");
    }
    try {
      char[] ksPw = keystorePassword == null ? new char[0] : keystorePassword.toCharArray();
      KeyStore keyStore = KeyStore.getInstance("PKCS12");
      try (InputStream in = Files.newInputStream(Path.of(keystorePath))) {
        keyStore.load(in, ksPw);
      }
      KeyManagerFactory kmf =
          KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
      kmf.init(keyStore, ksPw);

      char[] tsPw = truststorePassword == null ? new char[0] : truststorePassword.toCharArray();
      KeyStore trustStore = KeyStore.getInstance("PKCS12");
      try (InputStream in = Files.newInputStream(Path.of(truststorePath))) {
        trustStore.load(in, tsPw);
      }
      TrustManagerFactory tmf =
          TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
      tmf.init(trustStore);

      SSLContext ctx = SSLContext.getInstance("TLS");
      ctx.init(kmf.getKeyManagers(), tmf.getTrustManagers(), null);
      return ctx;
    } catch (Exception e) {
      throw new IllegalStateException(
          "failed to build internal mTLS client SSL context (keystore "
              + keystorePath
              + ", truststore "
              + truststorePath
              + ")",
          e);
    }
  }
}
