package io.hydropark.auth.config;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/**
 * OAuth provider verification config (SF6). Bound from {@code hydropark.auth.oauth.providers.*}. It is
 * fine for these to be unset in dev - {@code OAuthTokenVerifier} then throws a clear
 * {@code ApiException} rather than silently trusting a token.
 *
 * <pre>
 * hydropark.auth.oauth.providers.google.jwks-uri: https://www.googleapis.com/oauth2/v3/certs
 * hydropark.auth.oauth.providers.google.issuers[0]: https://accounts.google.com
 * hydropark.auth.oauth.providers.google.audiences[0]: &lt;our-google-client-id&gt;
 * </pre>
 *
 * <p>This lives in the {@code auth} package (not the shared {@code config} package) so it can be added
 * without touching foundation code; a {@code @Component}-annotated {@code @ConfigurationProperties}
 * bean is still bound by Spring Boot.
 */
@Component
@ConfigurationProperties(prefix = "hydropark.auth.oauth")
public class OAuthProperties {

  private Map<String, Provider> providers = new LinkedHashMap<>();

  public Map<String, Provider> getProviders() {
    return providers;
  }

  public void setProviders(Map<String, Provider> providers) {
    this.providers = providers;
  }

  public Provider get(String name) {
    return providers.get(name);
  }

  public static class Provider {
    /** Provider JWKS endpoint. Its keys verify the {@code id_token} signature. */
    private String jwksUri;

    /** Accepted {@code iss} values (Google publishes two forms). */
    private List<String> issuers = new ArrayList<>();

    /** Our client ids; the token's {@code aud} must contain one. */
    private List<String> audiences = new ArrayList<>();

    public String getJwksUri() {
      return jwksUri;
    }

    public void setJwksUri(String jwksUri) {
      this.jwksUri = jwksUri;
    }

    public List<String> getIssuers() {
      return issuers;
    }

    public void setIssuers(List<String> issuers) {
      this.issuers = issuers;
    }

    public List<String> getAudiences() {
      return audiences;
    }

    public void setAudiences(List<String> audiences) {
      this.audiences = audiences;
    }
  }
}
