package io.hydropark.packaging;

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
 * The <b>package-signing</b> trusted-key set: the same by-{@code kid} rolling-window pattern as the
 * licensing {@code TrustedKeySet}, but an entirely SEPARATE set for a separate key class (SPEC §13.8,
 * §8.8). It never sees license key material and the license set never sees package key material — the
 * whole point is that a compromise or role confusion in one cannot make the other sign or verify.
 *
 * <p>Package signing is Ed25519 (the schema's {@code ed25519:} wire form), so this set parses Ed25519
 * public keys (X.509 SPKI) for verification and, on the registry/signing zone only, the Ed25519
 * private half (PKCS#8). Ordered oldest → newest; the last K are kept.
 */
@Component
public class PackageTrustedKeySet {

  /** One key in the trusted window. {@code privateKey} is null off the registry/signing zone. */
  public record PackageKey(String kid, PublicKey publicKey, PrivateKey privateKey, boolean active) {}

  private final List<PackageKey> keys; // oldest -> newest
  private final Map<String, PackageKey> byKid;
  private final PackageKey active;

  @Autowired
  public PackageTrustedKeySet(PackageSigningProperties props) {
    this(props.getKeys(), props.getTrustedKeySetSize());
  }

  /** Direct constructor for tests. {@code configKeys} is oldest → newest. */
  public PackageTrustedKeySet(List<PackageSigningProperties.Key> configKeys, int k) {
    List<PackageKey> parsed = new ArrayList<>();
    for (PackageSigningProperties.Key sk : configKeys) {
      if (sk == null || sk.getKid() == null || sk.getKid().isBlank()) {
        continue;
      }
      requireEd25519(sk.getAlg(), sk.getKid());
      parsed.add(
          new PackageKey(
              sk.getKid(),
              parsePublic(sk.getPublicKey(), sk.getKid()),
              parsePrivate(sk.getPrivateKey(), sk.getKid()),
              sk.isActive()));
    }
    if (k > 0 && parsed.size() > k) {
      parsed = new ArrayList<>(parsed.subList(parsed.size() - k, parsed.size()));
    }
    this.keys = List.copyOf(parsed);

    Map<String, PackageKey> map = new LinkedHashMap<>();
    PackageKey act = null;
    for (PackageKey pk : this.keys) {
      if (pk.publicKey() != null) {
        map.put(pk.kid(), pk);
      }
      if (pk.active()) {
        act = pk;
      }
    }
    this.byKid = Map.copyOf(map);
    this.active = act;
  }

  /** The public key trusted under {@code kid}, or empty if unknown / rolled off. */
  public Optional<PublicKey> verifierFor(String kid) {
    PackageKey pk = byKid.get(kid);
    return Optional.ofNullable(pk == null ? null : pk.publicKey());
  }

  /** The active key without asserting a private half (kid + public only). */
  public Optional<PackageKey> activeKeyOrEmpty() {
    return Optional.ofNullable(active);
  }

  /** The signing key; present only where a private half is configured (the registry/signing zone). */
  public PackageKey active() {
    if (active == null) {
      throw new IllegalStateException(
          "no active package-signing key configured — exactly one"
              + " hydropark.package-signing.keys entry must be active");
    }
    if (active.privateKey() == null) {
      throw new IllegalStateException(
          "active package-signing key '" + active.kid() + "' has no private half on this zone");
    }
    return active;
  }

  public List<PackageKey> keys() {
    return keys;
  }

  private static void requireEd25519(String alg, String kid) {
    if (alg == null || alg.isBlank()) {
      return; // defaults to Ed25519
    }
    String norm = alg.trim();
    if (!norm.equalsIgnoreCase("Ed25519") && !norm.equalsIgnoreCase("EdDSA")) {
      throw new IllegalStateException(
          "package-signing key '" + kid + "' alg must be Ed25519 (got '" + alg + "')");
    }
  }

  private static PublicKey parsePublic(String base64, String kid) {
    if (base64 == null || base64.isBlank()) {
      return null;
    }
    try {
      byte[] der = Base64.getDecoder().decode(base64.replaceAll("\\s", ""));
      return KeyFactory.getInstance("Ed25519").generatePublic(new X509EncodedKeySpec(der));
    } catch (Exception e) {
      throw new IllegalStateException(
          "invalid Ed25519 package public key for kid '" + kid + "' (expect base64 X.509 SPKI)", e);
    }
  }

  private static PrivateKey parsePrivate(String base64, String kid) {
    if (base64 == null || base64.isBlank()) {
      return null;
    }
    try {
      byte[] der = Base64.getDecoder().decode(base64.replaceAll("\\s", ""));
      return KeyFactory.getInstance("Ed25519").generatePrivate(new PKCS8EncodedKeySpec(der));
    } catch (Exception e) {
      throw new IllegalStateException(
          "invalid Ed25519 package private key for kid '" + kid + "' (expect base64 PKCS#8)", e);
    }
  }
}
