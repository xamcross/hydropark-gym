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
 * <p>On the issuer zone each key also carries its <b>private</b> half (from Fly encrypted secrets -
 * the §11.2 interim custody); on every other zone the private half is absent and only verification is
 * possible. Keys are ordered oldest &rarr; newest, so index 0 is the next to roll off - which is what
 * {@link RollingKeyReissuer} watches.
 *
 * <p><b>Dual-algorithm (P1-16.8).</b> New issuance is <b>ES256</b> (ECDSA P-256), but licenses
 * already deployed under older <b>EdDSA</b> (Ed25519) kids must keep verifying (the §6.3 no-stranding
 * rule). So this set parses <b>both</b> EC P-256 and Ed25519 public keys and tags each {@link
 * TrustedKey} with its algorithm ({@code ES256} / {@code EdDSA}). The tag comes from the config
 * {@code alg} when present, otherwise it is <b>inferred from the key material</b> so pre-existing
 * Ed25519-only config still loads. The verifier reads this per-{@code kid} tag to pick the verify
 * algorithm — it never lets the JWS header's {@code alg} choose it (alg-confusion defense, §6.1).
 */
@Component
public class TrustedKeySet {

  /**
   * One key in the trusted window. {@code privateKey} is null off the issuer zone. {@code alg} is the
   * pinned JWS algorithm for this {@code kid}: {@code ES256} or {@code EdDSA}.
   */
  public record TrustedKey(
      String kid, PublicKey publicKey, PrivateKey privateKey, boolean active, String alg) {}

  private final List<TrustedKey> keys; // oldest -> newest
  private final Map<String, PublicKey> verifiers; // kid -> public key
  private final Map<String, TrustedKey> byKid; // kid -> full key (carries the pinned alg)
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
      String alg = resolveAlg(sk.getAlg(), sk.getPublicKey(), sk.getPrivateKey(), sk.getKid());
      parsed.add(
          new TrustedKey(
              sk.getKid(),
              parsePublic(sk.getPublicKey(), alg),
              parsePrivate(sk.getPrivateKey(), alg),
              sk.isActive(),
              alg));
    }
    // The shipped set is the last K keys; anything older has rolled off.
    if (k > 0 && parsed.size() > k) {
      parsed = new ArrayList<>(parsed.subList(parsed.size() - k, parsed.size()));
    }
    this.keys = List.copyOf(parsed);

    Map<String, PublicKey> v = new LinkedHashMap<>();
    Map<String, TrustedKey> byKidMap = new LinkedHashMap<>();
    TrustedKey act = null;
    for (TrustedKey tk : this.keys) {
      if (tk.publicKey() != null) {
        v.put(tk.kid(), tk.publicKey());
        byKidMap.put(tk.kid(), tk);
      }
      if (tk.active()) {
        act = tk; // the newest active wins if config is malformed with several
      }
    }
    this.verifiers = Map.copyOf(v);
    this.byKid = Map.copyOf(byKidMap);
    this.active = act;
  }

  /**
   * The active-flagged key <b>without</b> asserting a private half is present. Empty if no key is
   * flagged active. Use this on the PKCS#11/HSM path (P1-16.8): there the private half lives in
   * hardware and is absent from config, so only the {@code kid} + public half are known here — which
   * is all the signer needs from the trusted set (it addresses the private key by PKCS#11 label).
   */
  public Optional<TrustedKey> activeKeyOrEmpty() {
    return Optional.ofNullable(active);
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

  /**
   * The full trusted key for {@code kid} — its public half <b>and its pinned algorithm</b> — or
   * empty if unknown / rolled off. The verifier uses this so the algorithm is chosen per {@code kid}
   * from the trusted set, never from the untrusted JWS header (alg-confusion defense, §6.1).
   */
  public Optional<TrustedKey> trustedKeyFor(String kid) {
    return Optional.ofNullable(byKid.get(kid));
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
    sk.setAlg(tk.alg());
    if (tk.publicKey() != null) {
      sk.setPublicKey(Base64.getEncoder().encodeToString(tk.publicKey().getEncoded()));
    }
    if (tk.privateKey() != null) {
      sk.setPrivateKey(Base64.getEncoder().encodeToString(tk.privateKey().getEncoded()));
    }
    return sk;
  }

  // ---------------------------------------------------------------------------------------------
  // Dual-algorithm key parsing (P1-16.8). Both ES256 (EC P-256) and EdDSA (Ed25519) public/private
  // keys use the same containers as before — X.509 SPKI (public) / PKCS#8 (private), base64 — only
  // the curve differs, so the JCA KeyFactory algorithm is the only thing that changes.
  // ---------------------------------------------------------------------------------------------

  /** ES256 -> EC (P-256); EdDSA -> Ed25519. */
  private static String keyFactoryAlgorithm(String jwsAlg) {
    return switch (jwsAlg) {
      case "ES256" -> "EC";
      case "EdDSA" -> "Ed25519";
      default -> throw new IllegalStateException("unsupported signing-key alg: " + jwsAlg);
    };
  }

  /**
   * Determine the pinned JWS algorithm for a key. If config states {@code alg}, that wins (normalized
   * to {@code ES256}/{@code EdDSA}). Otherwise it is <b>inferred from the key material</b> — an EC
   * SPKI/PKCS#8 → {@code ES256}, an Ed25519 one → {@code EdDSA} — so existing Ed25519-only config
   * (which predates the {@code alg} field) still loads unchanged.
   */
  private static String resolveAlg(String configAlg, String pubB64, String privB64, String kid) {
    if (configAlg != null && !configAlg.isBlank()) {
      String norm = configAlg.trim();
      if (norm.equalsIgnoreCase("ES256")) {
        return "ES256";
      }
      if (norm.equalsIgnoreCase("EdDSA") || norm.equalsIgnoreCase("Ed25519")) {
        return "EdDSA";
      }
      throw new IllegalStateException(
          "unsupported hydropark.licensing.keys[" + kid + "].alg='" + configAlg + "' (want ES256 or EdDSA)");
    }
    String material = (pubB64 != null && !pubB64.isBlank()) ? pubB64 : privB64;
    if (material == null || material.isBlank()) {
      throw new IllegalStateException("signing key '" + kid + "' has neither public nor private material");
    }
    String inferred = inferAlgFromKeyMaterial(material);
    if (inferred == null) {
      throw new IllegalStateException(
          "cannot infer alg for key '" + kid + "'; set hydropark.licensing.keys[].alg to ES256 or EdDSA");
    }
    return inferred;
  }

  /** Try EC then Ed25519; the embedded algorithm OID makes exactly one KeyFactory accept the bytes. */
  private static String inferAlgFromKeyMaterial(String base64) {
    byte[] der;
    try {
      der = Base64.getDecoder().decode(base64.replaceAll("\\s", ""));
    } catch (RuntimeException e) {
      return null;
    }
    // A public SPKI is far more common in shipped config; try it as SPKI first, then PKCS#8.
    for (String kf : new String[] {"EC", "Ed25519"}) {
      if (canParse(kf, der, true) || canParse(kf, der, false)) {
        return "EC".equals(kf) ? "ES256" : "EdDSA";
      }
    }
    return null;
  }

  private static boolean canParse(String keyFactoryAlg, byte[] der, boolean asPublic) {
    try {
      KeyFactory kf = KeyFactory.getInstance(keyFactoryAlg);
      if (asPublic) {
        kf.generatePublic(new X509EncodedKeySpec(der));
      } else {
        kf.generatePrivate(new PKCS8EncodedKeySpec(der));
      }
      return true;
    } catch (Exception e) {
      return false;
    }
  }

  private static PublicKey parsePublic(String base64, String jwsAlg) {
    if (base64 == null || base64.isBlank()) {
      return null;
    }
    String kfAlg = keyFactoryAlgorithm(jwsAlg);
    try {
      byte[] der = Base64.getDecoder().decode(base64.replaceAll("\\s", ""));
      return KeyFactory.getInstance(kfAlg).generatePublic(new X509EncodedKeySpec(der));
    } catch (Exception e) {
      throw new IllegalStateException(
          "invalid " + jwsAlg + " public key (expect base64 X.509 SPKI for " + kfAlg + ")", e);
    }
  }

  private static PrivateKey parsePrivate(String base64, String jwsAlg) {
    if (base64 == null || base64.isBlank()) {
      return null;
    }
    String kfAlg = keyFactoryAlgorithm(jwsAlg);
    try {
      byte[] der = Base64.getDecoder().decode(base64.replaceAll("\\s", ""));
      return KeyFactory.getInstance(kfAlg).generatePrivate(new PKCS8EncodedKeySpec(der));
    } catch (Exception e) {
      throw new IllegalStateException(
          "invalid " + jwsAlg + " private key (expect base64 PKCS#8 for " + kfAlg + ")", e);
    }
  }
}
