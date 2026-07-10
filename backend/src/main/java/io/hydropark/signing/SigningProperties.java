package io.hydropark.signing;

import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/**
 * The signer-selection config surface under {@code hydropark.signing.*} (BACKLOG P1-16.8). Kept out
 * of {@code AppProperties} deliberately: the migration agent owns {@code config/}, so this ticket
 * adds its own {@code @ConfigurationProperties} class in the package it owns (per the ticket's
 * concurrency rule). It binds via {@code @Component} because the application enables config
 * properties explicitly ({@code @EnableConfigurationProperties(AppProperties.class)}) rather than
 * scanning for them.
 *
 * <p>Only the issuer zone consumes this (the signer beans are gated on {@code
 * hydropark.issuer.enabled=true}); on other zones the bean exists but is unused.
 */
@Component
@ConfigurationProperties(prefix = "hydropark.signing")
public class SigningProperties {

  /**
   * Which {@link Signer} the issuer zone wires. {@code jdk} (default) = in-memory JDK-native
   * Ed25519 (the interim custody, P1-16.3). {@code pkcs11} = a hardware HSM over PKCS#11 that
   * supports EdDSA (YubiHSM 2 / Thales Luna / Entrust nShield). No cloud KMS value exists because no
   * cloud KMS signs Ed25519 — see {@code docs/HSM-MIGRATION.md}.
   */
  private String provider = "jdk";

  private final Pkcs11 pkcs11 = new Pkcs11();

  public String getProvider() {
    return provider;
  }

  public void setProvider(String provider) {
    this.provider = provider;
  }

  public Pkcs11 getPkcs11() {
    return pkcs11;
  }

  /**
   * PKCS#11 provider settings for {@link Pkcs11Ed25519Signer}. All blank by default → the signer is
   * <b>unconfigured</b> and refuses to sign (it throws) until an operator supplies a real provider.
   * These fields are the exact SunPKCS11 configuration knobs; finishing the HSM path is populating
   * them + installing the vendor driver, not writing new code.
   */
  public static class Pkcs11 {

    /**
     * Path to a ready-made SunPKCS11 config file ({@code name=…}, {@code library=…}, {@code slot=…}
     * / {@code slotListIndex=…}). If set, it wins over the synthesized inline config below. If both
     * this and {@link #library} are blank the signer is treated as unconfigured.
     */
    private String configPath = "";

    /** Vendor PKCS#11 shared library, e.g. {@code /usr/lib/pkcs11/yubihsm_pkcs11.so}. */
    private String library = "";

    /** Provider instance name (informational; becomes {@code SunPKCS11-<name>}). */
    private String name = "hydropark-hsm";

    /** Token slot id. Use this or {@link #tokenLabel} (label is friendlier across re-plugs). */
    private String slot = "";

    /** Token label — an alternative to a numeric {@link #slot}. */
    private String tokenLabel = "";

    /**
     * The PIN / password that authenticates the PKCS#11 session. Injected from a secret at runtime;
     * never logged, never returned. May be blank for tokens with no login (rare for signing HSMs).
     */
    private String pin = "";

    /**
     * The JCA signature algorithm name the HSM's provider exposes for Ed25519. Almost always {@code
     * Ed25519}; a few vendors register it as {@code EdDSA}. Configurable so a driver quirk is a
     * config change, not a code change.
     */
    private String signatureAlgorithm = "Ed25519";

    /**
     * Maps each licensing {@code kid} (from {@code hydropark.licensing.keys[].kid}) to the PKCS#11
     * object <b>label</b> of that key's private half inside the token. Absent an entry, the {@code
     * kid} itself is used as the label. This is the join between "which key the JWS header names"
     * and "which handle {@code C_Sign} runs against".
     */
    private Map<String, String> keyLabels = new LinkedHashMap<>();

    public String getConfigPath() {
      return configPath;
    }

    public void setConfigPath(String configPath) {
      this.configPath = configPath;
    }

    public String getLibrary() {
      return library;
    }

    public void setLibrary(String library) {
      this.library = library;
    }

    public String getName() {
      return name;
    }

    public void setName(String name) {
      this.name = name;
    }

    public String getSlot() {
      return slot;
    }

    public void setSlot(String slot) {
      this.slot = slot;
    }

    public String getTokenLabel() {
      return tokenLabel;
    }

    public void setTokenLabel(String tokenLabel) {
      this.tokenLabel = tokenLabel;
    }

    public String getPin() {
      return pin;
    }

    public void setPin(String pin) {
      this.pin = pin;
    }

    public String getSignatureAlgorithm() {
      return signatureAlgorithm;
    }

    public void setSignatureAlgorithm(String signatureAlgorithm) {
      this.signatureAlgorithm = signatureAlgorithm;
    }

    public Map<String, String> getKeyLabels() {
      return keyLabels;
    }

    public void setKeyLabels(Map<String, String> keyLabels) {
      this.keyLabels = keyLabels;
    }

    /** True once enough is configured to attempt a real provider load. */
    public boolean isConfigured() {
      return !configPath.isBlank() || !library.isBlank();
    }
  }
}
