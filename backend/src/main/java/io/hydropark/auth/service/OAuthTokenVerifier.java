package io.hydropark.auth.service;

import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.jwk.source.JWKSource;
import com.nimbusds.jose.jwk.source.RemoteJWKSet;
import com.nimbusds.jose.proc.JWSKeySelector;
import com.nimbusds.jose.proc.JWSVerificationKeySelector;
import com.nimbusds.jose.proc.SecurityContext;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.proc.ConfigurableJWTProcessor;
import com.nimbusds.jwt.proc.DefaultJWTClaimsVerifier;
import com.nimbusds.jwt.proc.DefaultJWTProcessor;
import io.hydropark.auth.config.OAuthProperties;
import io.hydropark.common.ApiException;
import io.hydropark.common.ErrorCode;
import java.net.URI;
import java.net.URL;
import java.text.ParseException;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Component;

/**
 * Verifies a provider {@code id_token} (SF6). It pins RS256 and resolves the signing key from the
 * provider JWKS via Nimbus {@link RemoteJWKSet}/{@link JWKSource} - the signature is checked against
 * the provider's published key, never trusted. It then asserts {@code iss}, {@code aud} (our client
 * ids), {@code exp} (Nimbus default verifier), and {@code nonce}.
 *
 * <p>Providers may be unset in dev; a call for an unconfigured provider throws a clear
 * {@code ApiException} instead of silently accepting the token.
 */
@Component
public class OAuthTokenVerifier {

  private final OAuthProperties props;
  private final Map<String, ConfigurableJWTProcessor<SecurityContext>> processors =
      new ConcurrentHashMap<>();

  public OAuthTokenVerifier(OAuthProperties props) {
    this.props = props;
  }

  /** The claims we trust from a verified token. */
  public record VerifiedIdentity(String sub, String email, boolean emailVerified) {}

  public VerifiedIdentity verify(String provider, String idToken, String nonce) {
    OAuthProperties.Provider cfg = props.get(provider);
    if (cfg == null || cfg.getJwksUri() == null || cfg.getJwksUri().isBlank()) {
      // Configuration gap, not a client error: fail clearly rather than trust an unverifiable token.
      throw new ApiException(
          ErrorCode.INTERNAL_ERROR, "oauth provider not configured: " + provider);
    }

    ConfigurableJWTProcessor<SecurityContext> processor =
        processors.computeIfAbsent(provider, p -> build(cfg));

    JWTClaimsSet claims;
    try {
      // Verifies signature (RS256, provider JWKS) + exp/required-claims. No SecurityContext needed.
      claims = processor.process(idToken, null);
    } catch (Exception e) {
      throw new ApiException(ErrorCode.UNAUTHORIZED, "invalid oauth id_token");
    }

    if (cfg.getIssuers().stream().noneMatch(i -> i.equals(claims.getIssuer()))) {
      throw new ApiException(ErrorCode.UNAUTHORIZED, "oauth id_token issuer mismatch");
    }

    List<String> aud = claims.getAudience();
    if (aud == null || cfg.getAudiences().stream().noneMatch(aud::contains)) {
      throw new ApiException(ErrorCode.UNAUTHORIZED, "oauth id_token audience mismatch");
    }

    // Nonce binds the token to this login attempt; a replayed token from another flow fails here.
    if (nonce == null || nonce.isBlank() || !nonce.equals(stringClaim(claims, "nonce"))) {
      throw new ApiException(ErrorCode.UNAUTHORIZED, "oauth id_token nonce mismatch");
    }

    String sub = claims.getSubject();
    if (sub == null || sub.isBlank()) {
      throw new ApiException(ErrorCode.UNAUTHORIZED, "oauth id_token missing sub");
    }

    String email = stringClaim(claims, "email");
    boolean emailVerified = Boolean.TRUE.equals(boolClaim(claims, "email_verified"));
    return new VerifiedIdentity(sub, email, emailVerified);
  }

  private ConfigurableJWTProcessor<SecurityContext> build(OAuthProperties.Provider cfg) {
    URL url;
    try {
      url = URI.create(cfg.getJwksUri()).toURL();
    } catch (Exception e) {
      throw new ApiException(ErrorCode.INTERNAL_ERROR, "bad oauth jwks uri");
    }
    DefaultJWTProcessor<SecurityContext> processor = new DefaultJWTProcessor<>();
    JWKSource<SecurityContext> source = new RemoteJWKSet<>(url);
    JWSKeySelector<SecurityContext> selector =
        new JWSVerificationKeySelector<>(JWSAlgorithm.RS256, source);
    processor.setJWSKeySelector(selector);
    // Require the claims we assert; exp/nbf are auto-verified by the default verifier.
    processor.setJWTClaimsSetVerifier(
        new DefaultJWTClaimsVerifier<>(
            (JWTClaimsSet) null, Set.of("sub", "iss", "aud", "exp", "nonce")));
    return processor;
  }

  private static String stringClaim(JWTClaimsSet claims, String name) {
    try {
      return claims.getStringClaim(name);
    } catch (ParseException e) {
      return null;
    }
  }

  private static Boolean boolClaim(JWTClaimsSet claims, String name) {
    try {
      return claims.getBooleanClaim(name);
    } catch (ParseException e) {
      return null;
    }
  }
}
