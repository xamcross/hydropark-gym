package io.hydropark.licensing;

import io.hydropark.config.AppProperties;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.spec.ECGenParameterSpec;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

/**
 * Test helper: {@link AppProperties} carrying freshly generated license signing keys.
 *
 * <p>The default {@link #propsWithFreshKey} now generates an <b>ES256</b> (ECDSA P-256) key — the
 * current active-signing algorithm (P1-16.8) — so the round-trip/authorization/re-issue tests all
 * exercise the ES256 path. {@link #freshEd25519} is retained for the dual-algorithm tests that must
 * prove an older Ed25519-signed license still verifies alongside a new ES256 one.
 */
final class LicensingTestKeys {

  private LicensingTestKeys() {}

  /** Raw generated key material for a kid, in the base64 containers the config binds. */
  record KeyMaterial(String kid, String alg, String privB64, String pubB64) {}

  /** ES256 = ECDSA over NIST P-256 (secp256r1 / prime256v1). */
  static KeyMaterial freshEs256(String kid) {
    try {
      KeyPairGenerator g = KeyPairGenerator.getInstance("EC");
      g.initialize(new ECGenParameterSpec("secp256r1"));
      return material(kid, "ES256", g.generateKeyPair());
    } catch (Exception e) {
      throw new RuntimeException("failed to generate ES256 (P-256) test key", e);
    }
  }

  static KeyMaterial freshEd25519(String kid) {
    try {
      KeyPairGenerator g = KeyPairGenerator.getInstance("Ed25519");
      return material(kid, "EdDSA", g.generateKeyPair());
    } catch (Exception e) {
      throw new RuntimeException("failed to generate Ed25519 test key", e);
    }
  }

  private static KeyMaterial material(String kid, String alg, KeyPair kp) {
    return new KeyMaterial(
        kid,
        alg,
        Base64.getEncoder().encodeToString(kp.getPrivate().getEncoded()),
        Base64.getEncoder().encodeToString(kp.getPublic().getEncoded()));
  }

  static AppProperties.SigningKey toSigningKey(KeyMaterial km, boolean active) {
    AppProperties.SigningKey sk = new AppProperties.SigningKey();
    sk.setKid(km.kid());
    sk.setAlg(km.alg());
    sk.setPrivateKey(km.privB64());
    sk.setPublicKey(km.pubB64());
    sk.setActive(active);
    return sk;
  }

  static AppProperties propsWith(AppProperties.SigningKey... keys) {
    AppProperties props = new AppProperties();
    props.getLicensing().setKeys(new ArrayList<>(List.of(keys)));
    return props;
  }

  /** The default: a single active ES256 key. */
  static AppProperties propsWithFreshKey(String kid) {
    return propsWith(toSigningKey(freshEs256(kid), true));
  }

  /** A single active Ed25519 key (for verifying "old" licenses in the dual-algorithm tests). */
  static AppProperties propsWithFreshEd25519Key(String kid) {
    return propsWith(toSigningKey(freshEd25519(kid), true));
  }
}
