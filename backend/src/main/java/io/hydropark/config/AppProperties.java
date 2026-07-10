package io.hydropark.config;

import java.util.ArrayList;
import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;

/** All tunables under the {@code hydropark.*} prefix. */
@ConfigurationProperties(prefix = "hydropark")
public class AppProperties {

  private final Zone api = new Zone();
  private final Zone issuer = new Zone();
  private final Zone worker = new Zone();
  private final Auth auth = new Auth();
  private final Licensing licensing = new Licensing();
  private final Payments payments = new Payments();
  private final Devices devices = new Devices();

  public static class Zone {
    private boolean enabled = true;

    public boolean isEnabled() {
      return enabled;
    }

    public void setEnabled(boolean enabled) {
      this.enabled = enabled;
    }
  }

  public static class Auth {
    /** §8 - access JWT ~15 min. */
    private long accessTokenTtlSeconds = 900;

    /** §8 - refresh token 30-90 days. */
    private long refreshTokenTtlSeconds = 60L * 60 * 24 * 60;

    /**
     * §8 - re-presenting the immediately-prior refresh token within this window returns the same
     * rotation result instead of tripping family revocation. Without it, a dropped response on a
     * flaky network logs the user out.
     */
    private long refreshRetryGraceSeconds = 60;

    /** PKCS#8 base64 RSA private key for signing access JWTs. Generated at boot if blank (dev). */
    private String jwtPrivateKey = "";

    private String jwtKeyId = "hp-access-dev";
    private String issuerName = "hydropark";
    private long stepUpTokenTtlSeconds = 600;
    private long emailVerificationTtlSeconds = 60L * 60 * 24;
    private long passwordResetTtlSeconds = 60L * 60;

    public long getAccessTokenTtlSeconds() {
      return accessTokenTtlSeconds;
    }

    public void setAccessTokenTtlSeconds(long v) {
      this.accessTokenTtlSeconds = v;
    }

    public long getRefreshTokenTtlSeconds() {
      return refreshTokenTtlSeconds;
    }

    public void setRefreshTokenTtlSeconds(long v) {
      this.refreshTokenTtlSeconds = v;
    }

    public long getRefreshRetryGraceSeconds() {
      return refreshRetryGraceSeconds;
    }

    public void setRefreshRetryGraceSeconds(long v) {
      this.refreshRetryGraceSeconds = v;
    }

    public String getJwtPrivateKey() {
      return jwtPrivateKey;
    }

    public void setJwtPrivateKey(String v) {
      this.jwtPrivateKey = v;
    }

    public String getJwtKeyId() {
      return jwtKeyId;
    }

    public void setJwtKeyId(String v) {
      this.jwtKeyId = v;
    }

    public String getIssuerName() {
      return issuerName;
    }

    public void setIssuerName(String v) {
      this.issuerName = v;
    }

    public long getStepUpTokenTtlSeconds() {
      return stepUpTokenTtlSeconds;
    }

    public void setStepUpTokenTtlSeconds(long v) {
      this.stepUpTokenTtlSeconds = v;
    }

    public long getEmailVerificationTtlSeconds() {
      return emailVerificationTtlSeconds;
    }

    public void setEmailVerificationTtlSeconds(long v) {
      this.emailVerificationTtlSeconds = v;
    }

    public long getPasswordResetTtlSeconds() {
      return passwordResetTtlSeconds;
    }

    public void setPasswordResetTtlSeconds(long v) {
      this.passwordResetTtlSeconds = v;
    }
  }

  /** §6 - the sacred signer. */
  public static class Licensing {
    /** Ed25519 keys. Exactly one must be active; the rest remain trusted for verification. */
    private List<SigningKey> keys = new ArrayList<>();

    /** §6.3 - the app ships the last K public keys. */
    private int trustedKeySetSize = 5;

    private String issuerClaim = "hydropark-licensing";
    private int maxDevices = 5;

    /** §6.2 N12 - per-sub issuance limit is the primary control. */
    private int maxIssuancesPerUserPerHour = 20;

    /** Wide backstop only - never the primary limit. */
    private int maxIssuancesGlobalPerMinute = 600;

    public List<SigningKey> getKeys() {
      return keys;
    }

    public void setKeys(List<SigningKey> keys) {
      this.keys = keys;
    }

    public int getTrustedKeySetSize() {
      return trustedKeySetSize;
    }

    public void setTrustedKeySetSize(int v) {
      this.trustedKeySetSize = v;
    }

    public String getIssuerClaim() {
      return issuerClaim;
    }

    public void setIssuerClaim(String v) {
      this.issuerClaim = v;
    }

    public int getMaxDevices() {
      return maxDevices;
    }

    public void setMaxDevices(int v) {
      this.maxDevices = v;
    }

    public int getMaxIssuancesPerUserPerHour() {
      return maxIssuancesPerUserPerHour;
    }

    public void setMaxIssuancesPerUserPerHour(int v) {
      this.maxIssuancesPerUserPerHour = v;
    }

    public int getMaxIssuancesGlobalPerMinute() {
      return maxIssuancesGlobalPerMinute;
    }

    public void setMaxIssuancesGlobalPerMinute(int v) {
      this.maxIssuancesGlobalPerMinute = v;
    }
  }

  public static class SigningKey {
    /** e.g. {@code hp-lic-2026a} - names the key in the JWS header. */
    private String kid;

    /**
     * The JWS signature algorithm this key uses: {@code ES256} (ECDSA P-256 + SHA-256, the current
     * active-signing algorithm — P1-16.8) or {@code EdDSA} (Ed25519, older deployed keys kept for
     * verification only). <b>Blank/absent is tolerated for backward compatibility</b>: {@code
     * TrustedKeySet} then infers the algorithm from the key material itself (an EC SPKI/PKCS#8 →
     * {@code ES256}, an Ed25519 one → {@code EdDSA}), so pre-existing Ed25519-only config still loads
     * without this field. When set, it wins and the key material must match it.
     */
    private String alg = "";

    /** base64 PKCS#8 private key (EC P-256 for ES256, Ed25519 for EdDSA). Only ever set on the issuer zone. */
    private String privateKey = "";

    /** base64 X.509 SubjectPublicKeyInfo. Shipped in every app build. */
    private String publicKey = "";

    private boolean active;

    public String getKid() {
      return kid;
    }

    public void setKid(String kid) {
      this.kid = kid;
    }

    public String getAlg() {
      return alg;
    }

    public void setAlg(String alg) {
      this.alg = alg;
    }

    public String getPrivateKey() {
      return privateKey;
    }

    public void setPrivateKey(String v) {
      this.privateKey = v;
    }

    public String getPublicKey() {
      return publicKey;
    }

    public void setPublicKey(String v) {
      this.publicKey = v;
    }

    public boolean isActive() {
      return active;
    }

    public void setActive(boolean active) {
      this.active = active;
    }
  }

  public static class Payments {
    /** {@code stripe} or {@code fake}. §7 names Paddle/Lemon Squeezy as the production MoR. */
    private String provider = "fake";

    private String stripeApiKey = "";
    private String stripeWebhookSecret = "";
    private String successUrl = "hydropark://purchase/callback";
    private String cancelUrl = "hydropark://purchase/cancel";

    /** §3.4 SF10 - velocity limit per new/unverified account. */
    private int maxPurchasesPerUserPerDay = 10;

    public String getProvider() {
      return provider;
    }

    public void setProvider(String v) {
      this.provider = v;
    }

    public String getStripeApiKey() {
      return stripeApiKey;
    }

    public void setStripeApiKey(String v) {
      this.stripeApiKey = v;
    }

    public String getStripeWebhookSecret() {
      return stripeWebhookSecret;
    }

    public void setStripeWebhookSecret(String v) {
      this.stripeWebhookSecret = v;
    }

    public String getSuccessUrl() {
      return successUrl;
    }

    public void setSuccessUrl(String v) {
      this.successUrl = v;
    }

    public String getCancelUrl() {
      return cancelUrl;
    }

    public void setCancelUrl(String v) {
      this.cancelUrl = v;
    }

    public int getMaxPurchasesPerUserPerDay() {
      return maxPurchasesPerUserPerDay;
    }

    public void setMaxPurchasesPerUserPerDay(int v) {
      this.maxPurchasesPerUserPerDay = v;
    }
  }

  public static class Devices {
    private int maxActiveSlots = 5;

    /** §3.4 - generous soft budget; exceeding it triggers review, never a hard block. */
    private int lifetimeRotationSoftBudget = 15;

    public int getMaxActiveSlots() {
      return maxActiveSlots;
    }

    public void setMaxActiveSlots(int v) {
      this.maxActiveSlots = v;
    }

    public int getLifetimeRotationSoftBudget() {
      return lifetimeRotationSoftBudget;
    }

    public void setLifetimeRotationSoftBudget(int v) {
      this.lifetimeRotationSoftBudget = v;
    }
  }

  public Zone getApi() {
    return api;
  }

  public Zone getIssuer() {
    return issuer;
  }

  public Zone getWorker() {
    return worker;
  }

  public Auth getAuth() {
    return auth;
  }

  public Licensing getLicensing() {
    return licensing;
  }

  public Payments getPayments() {
    return payments;
  }

  public Devices getDevices() {
    return devices;
  }
}
