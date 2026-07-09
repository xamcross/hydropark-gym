package io.hydropark.licensing;

import io.hydropark.config.AppProperties;
import java.security.KeyFactory;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

/**
 * The K = 5 rolling trusted-key set (BACKEND-DESIGN §6.3, §13.8).
 *
 * <p>The app ships the last K issuer <b>public</b> keys; exactly one key is {@code active} for
 * signing and the rest remain trusted for verification. That window is what lets a device offline
 * across several rotations keep verifying its cached tokens under the older {@code kid} it already
 * trusts, while new issuance always uses the newest key.
 *
 * <p>On the issuer zone each key also carries its Ed25519 <b>private</b> half (from Fly encrypted
 * secrets - the §11.2 interim custody); on every other zone the private half is absent and only
 * verification is possible. Keys are ordered oldest &rarr; newest, so index 0 is the next to roll
 * off - which is what {@link RollingKeyReissuer} watches.
 */
@Component
public class TrustedKeySet {

  /** One key in the trusted window. {@code privateKey} is null off the issuer zone. */
  public record TrustedKey(String kid, PublicKey publicKey, PrivateKey privateKey, boolean active) {}

  private final List<TrustedKey> keys; // oldest -> newest
  private final Map<String, PublicKey> verifiers; // kid -> public key
  private final TrustedKey active;

  /**
   * The injection point. Explicitly marked because the class has a second public constructor (for
   * tests and {@link #rotate}), and Spring will not guess between two candidates - it falls back to
   * a no-arg constructor that does not exist, which only fails at context refresh.
   */
  @Autowired
  public TrustedKeySet(AppProperties props) {
    this(props.getLicensing().getKeys(), props.getLicensing().getTrustedKeySetSize());
  }

  /** Direct constructor for tests and for {@link #rotate}. {@code configKeys} is oldest -> newest. */
  public TrustedKeySet(List<AppProperties.SigningKey> configKeys, int k) {
    List<TrustedKey> parsed = new ArrayList<>();
    for (AppProperties.SigningKey sk : configKeys) {
      if (sk == null || sk.getKid() == null || sk.getKid().isBlank()) {
        continue;
      }
      parsed.add(
          new TrustedKey(
              sk.getKid(),
              parsePublic(sk.getPublicKey()),
              parsePrivate(sk.getPrivateKey()),
              sk.isActive()));
    }
    // The shipped set is the last K keys; anything older has rolled off.
    if (k > 0 && parsed.size() > k) {
      parsed = new ArrayList<>(parsed.subList(parsed.size() - k, parsed.size()));
    }
    this.keys = List.copyOf(parsed);

    Map<String, PublicKey> v = new LinkedHashMap<>();
    TrustedKey act = null;
    for (TrustedKey tk : this.keys) {
      if (tk.publicKey() != null) {
        v.put(tk.kid(), tk.publicKey());
      }
      if (tk.active()) {
        act = tk; // the newest active wins if config is malformed with several
      }
    }
    this.verifiers = Map.copyOf(v);
    this.active = act;
  }

  /**
   * The signing key. Present only where a private key is configured (the issuer zone); callers off
   * that zone never reach here because the signer bean itself is gated on {@code issuer.enabled}.
   */
  public TrustedKey active() {
    if (active == null) {
      throw new IllegalStateException(
          "no active signing key configured - exactly one hydropark.licensing.keys entry must be active");
    }
    if (active.privateKey() == null) {
      throw new IllegalStateException(
          "active signing key '" + active.kid() + "' has no private half on this zone");
    }
    return active;
  }

  /** The public key trusted under {@code kid}, or empty if it is unknown / rolled off. */
  public Optional<PublicKey> verifierFor(String kid) {
    return Optional.ofNullable(verifiers.get(kid));
  }

  /** The kids currently in the shipped trusted window. */
  public java.util.Set<String> kids() {
    return verifiers.keySet();
  }

  /** The oldest kid still in the window - the next to roll off on the following rotation. */
  public Optional<String> oldestKid() {
    return keys.isEmpty() ? Optional.empty() : Optional.of(keys.get(0).kid());
  }

  public List<TrustedKey> keys() {
    return keys;
  }

  /**
   * §6.3 rotation, as a pure function for reasoning/tests: append {@code newKey} as the sole active
   * key, demote the rest to verify-only, and roll the oldest off the K-window. The production set is
   * built from config at boot; this documents the shape the config change must produce.
   */
  public TrustedKeySet rotate(AppProperties.SigningKey newKey, int k) {
    List<AppProperties.SigningKey> next = new ArrayList<>();
    for (TrustedKey tk : keys) {
      next.add(toConfig(tk, false));
    }
    newKey.setActive(true);
    next.add(newKey);
    return new TrustedKeySet(next, k);
  }

  private static AppProperties.SigningKey toConfig(TrustedKey tk, boolean active) {
    AppProperties.SigningKey sk = new AppProperties.SigningKey();
    sk.setKid(tk.kid());
    sk.setActive(active);
    if (tk.publicKey() != null) {
      sk.setPublicKey(Base64.getEncoder().encodeToString(tk.publicKey().getEncoded()));
    }
    if (tk.privateKey() != null) {
      sk.setPrivateKey(Base64.getEncoder().encodeToString(tk.privateKey().getEncoded()));
    }
    return sk;
  }

  private static PublicKey parsePublic(String base64) {
    if (base64 == null || base64.isBlank()) {
      return null;
    }
    try {
      byte[] der = Base64.getDecoder().decode(base64.replaceAll("\\s", ""));
      return KeyFactory.getInstance("Ed25519").generatePublic(new X509EncodedKeySpec(der));
    } catch (Exception e) {
      throw new IllegalStateException("invalid Ed25519 public key (expect base64 X.509 SPKI)", e);
    }
  }

  private static PrivateKey parsePrivate(String base64) {
    if (base64 == null || base64.isBlank()) {
      return null;
    }
    try {
      byte[] der = Base64.getDecoder().decode(base64.replaceAll("\\s", ""));
      return KeyFactory.getInstance("Ed25519").generatePrivate(new PKCS8EncodedKeySpec(der));
    } catch (Exception e) {
      throw new IllegalStateException("invalid Ed25519 private key (expect base64 PKCS#8)", e);
    }
  }
}
