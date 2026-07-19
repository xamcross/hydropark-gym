package io.hydropark.packaging;

import java.util.ArrayList;
import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/**
 * The <b>package-signing</b> key material, under {@code hydropark.package-signing.*} — deliberately a
 * SEPARATE surface from the sacred license key ({@code hydropark.licensing.*}) and from the license
 * signer-selection knobs ({@code hydropark.signing.*}). Package signing is a distinct key class (SPEC
 * §13.8, §8.8, BACKEND-DESIGN §6.2 B8): the license key must never sign a package and vice versa, so
 * they never share config, a bean, or a trusted set.
 *
 * <p>Binds via {@code @Component} for the same reason {@code SigningProperties} does: the application
 * enables config properties explicitly rather than scanning, so a {@code @ConfigurationProperties}
 * class registers itself as a component to be bound.
 *
 * <p>{@link #keys} mirrors the licensing K-rolling set (oldest → newest, exactly one active). Public
 * halves ship on every zone for offline verification; the private half is present only where the
 * registry actually signs. {@link #enabled} gates whether this zone mints signatures at all — see
 * {@code PackageSignerConfig}. All fields are env-overridable and never logged.
 */
@Component
@ConfigurationProperties(prefix = "hydropark.package-signing")
public class PackageSigningProperties {

  /**
   * Whether this zone mints package signatures (i.e. holds a private key and wires a {@link
   * PackageSigner}). Verification needs only public keys and works regardless of this flag. Default
   * false so a zone without package-signing custody never fails to boot.
   */
  private boolean enabled = false;

  /** The K rolling trusted package keys, oldest → newest; exactly one active. */
  private List<Key> keys = new ArrayList<>();

  /** §6.3-style rolling window: ship the last K public keys. */
  private int trustedKeySetSize = 5;

  public boolean isEnabled() {
    return enabled;
  }

  public void setEnabled(boolean enabled) {
    this.enabled = enabled;
  }

  public List<Key> getKeys() {
    return keys;
  }

  public void setKeys(List<Key> keys) {
    this.keys = keys;
  }

  public int getTrustedKeySetSize() {
    return trustedKeySetSize;
  }

  public void setTrustedKeySetSize(int trustedKeySetSize) {
    this.trustedKeySetSize = trustedKeySetSize;
  }

  /** One package-signing key. Ed25519 only (the schema wire form is {@code ed25519:...}). */
  public static class Key {
    /** e.g. {@code hp-pkg-2026a} — names the key in the manifest {@code signing_key_id}. */
    private String kid;

    /** Fixed at Ed25519 for the package key class; kept for forward-compat and validation. */
    private String alg = "Ed25519";

    /** base64 PKCS#8 Ed25519 private key. Only ever set on the registry/signing zone. */
    private String privateKey = "";

    /** base64 X.509 SubjectPublicKeyInfo. Shipped everywhere for offline verification. */
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

    public void setPrivateKey(String privateKey) {
      this.privateKey = privateKey;
    }

    public String getPublicKey() {
      return publicKey;
    }

    public void setPublicKey(String publicKey) {
      this.publicKey = publicKey;
    }

    public boolean isActive() {
      return active;
    }

    public void setActive(boolean active) {
      this.active = active;
    }
  }
}
