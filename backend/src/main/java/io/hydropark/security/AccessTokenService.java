package io.hydropark.security;

import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.JWSVerifier;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jose.crypto.RSASSAVerifier;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import io.hydropark.common.ApiException;
import io.hydropark.common.ErrorCode;
import io.hydropark.config.AppProperties;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.interfaces.RSAPrivateKey;
import java.security.interfaces.RSAPublicKey;
import java.security.spec.InvalidKeySpecException;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.RSAPublicKeySpec;
import java.text.ParseException;
import java.time.Instant;
import java.util.Base64;
import java.util.Date;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * Short-lived access JWTs (§8). Two properties matter more than convenience:
 *
 * <ol>
 *   <li><b>The algorithm is pinned.</b> Verification rejects any token whose header alg is not
 *       exactly RS256 - before touching the signature. This is what closes {@code alg:none} and
 *       RS256/HS256 confusion, where a public key gets used as an HMAC secret.
 *   <li><b>Claims are asserted, not read.</b> {@code iss} and {@code exp} are checked, not trusted.
 * </ol>
 *
 * <p>The license JWS is a different thing entirely and is <em>not</em> minted here - see
 * {@code licensing.LicenseSigner}, which uses Ed25519 and must never share a key with this service.
 */
@Service
public class AccessTokenService {

  private static final Logger log = LoggerFactory.getLogger(AccessTokenService.class);
  private static final JWSAlgorithm PINNED_ALG = JWSAlgorithm.RS256;

  private final AppProperties props;
  private final RSAPrivateKey privateKey;
  private final RSAPublicKey publicKey;
  private final String keyId;

  public AccessTokenService(AppProperties props) throws Exception {
    this.props = props;
    this.keyId = props.getAuth().getJwtKeyId();

    String configured = props.getAuth().getJwtPrivateKey();
    if (configured == null || configured.isBlank()) {
      // Dev convenience only. A generated key means every restart invalidates outstanding tokens,
      // which is correct for local dev and unacceptable in production - hence the warning.
      log.warn(
          "hydropark.auth.jwt-private-key is unset: generating an ephemeral RSA key. "
              + "Access tokens will not survive a restart. Set the key in every deployed env.");
      KeyPairGenerator gen = KeyPairGenerator.getInstance("RSA");
      gen.initialize(2048);
      KeyPair kp = gen.generateKeyPair();
      this.privateKey = (RSAPrivateKey) kp.getPrivate();
      this.publicKey = (RSAPublicKey) kp.getPublic();
    } else {
      byte[] der = Base64.getDecoder().decode(configured.replaceAll("\\s", ""));
      KeyFactory kf = KeyFactory.getInstance("RSA");
      try {
        this.privateKey = (RSAPrivateKey) kf.generatePrivate(new PKCS8EncodedKeySpec(der));
      } catch (InvalidKeySpecException e) {
        // The overwhelmingly common cause is a PKCS#1 key where PKCS#8 was expected. `openssl pkey
        // -outform DER` emits traditional PKCS#1 for RSA - a SEQUENCE of bare INTEGERs with no
        // AlgorithmIdentifier - and the JDK reports that as "algid parse error, not a sequence",
        // which names the symptom and hides the cause. Detect the shape and say what to run.
        boolean looksLikePkcs1 = der.length > 6 && der[0] == 0x30 && der[4] == 0x02 && der[7] == 0x02;
        throw new IllegalStateException(
            "hydropark.auth.jwt-private-key could not be parsed as PKCS#8"
                + (looksLikePkcs1
                    ? ": it looks like a traditional PKCS#1 RSAPrivateKey. Re-encode it with "
                        + "`openssl pkcs8 -topk8 -nocrypt -in key.pem -outform DER` "
                        + "(NOT `openssl pkey -outform DER`, which writes PKCS#1 for RSA)."
                    : " (expected base64 of a DER PrivateKeyInfo)."),
            e);
      }
      this.publicKey =
          (RSAPublicKey)
              kf.generatePublic(
                  new RSAPublicKeySpec(privateKey.getModulus(), java.math.BigInteger.valueOf(65537)));
    }
  }

  public String issue(String userId, boolean emailVerified) {
    Instant now = Instant.now();
    JWTClaimsSet claims =
        new JWTClaimsSet.Builder()
            .subject(userId)
            .issuer(props.getAuth().getIssuerName())
            .issueTime(Date.from(now))
            .expirationTime(Date.from(now.plusSeconds(props.getAuth().getAccessTokenTtlSeconds())))
            .claim("email_verified", emailVerified)
            .build();

    SignedJWT jwt =
        new SignedJWT(new JWSHeader.Builder(PINNED_ALG).keyID(keyId).build(), claims);
    try {
      jwt.sign(new RSASSASigner(privateKey));
    } catch (JOSEException e) {
      throw new IllegalStateException("failed to sign access token", e);
    }
    return jwt.serialize();
  }

  /** Verifies signature + alg pin + issuer + expiry. Throws 401 on any failure. */
  public AuthPrincipal verify(String token) {
    try {
      SignedJWT jwt = SignedJWT.parse(token);

      // Pin the algorithm BEFORE verifying: a token claiming HS256 must never reach an
      // HMAC verifier holding our RSA public key as the secret.
      if (!PINNED_ALG.equals(jwt.getHeader().getAlgorithm())) {
        throw unauthorized("unexpected token algorithm");
      }

      JWSVerifier verifier = new RSASSAVerifier(publicKey);
      if (!jwt.verify(verifier)) {
        throw unauthorized("bad token signature");
      }

      JWTClaimsSet claims = jwt.getJWTClaimsSet();
      if (!props.getAuth().getIssuerName().equals(claims.getIssuer())) {
        throw unauthorized("bad token issuer");
      }
      Date exp = claims.getExpirationTime();
      if (exp == null || exp.toInstant().isBefore(Instant.now())) {
        throw unauthorized("token expired");
      }

      Object verified = claims.getClaim("email_verified");
      return new AuthPrincipal(claims.getSubject(), Boolean.TRUE.equals(verified));
    } catch (ParseException | JOSEException e) {
      throw unauthorized("malformed token");
    }
  }

  /** X.509 SubjectPublicKeyInfo, base64 - published so other zones can verify without the private key. */
  public String publicKeyBase64() {
    return Base64.getEncoder().encodeToString(publicKey.getEncoded());
  }

  private static ApiException unauthorized(String msg) {
    return new ApiException(ErrorCode.UNAUTHORIZED, msg);
  }
}
