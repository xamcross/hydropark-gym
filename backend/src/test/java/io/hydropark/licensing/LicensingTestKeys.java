package io.hydropark.licensing;

import io.hydropark.config.AppProperties;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

/** Test helper: an {@link AppProperties} carrying a freshly generated Ed25519 signing key. */
final class LicensingTestKeys {

  private LicensingTestKeys() {}

  static AppProperties propsWithFreshKey(String kid) {
    try {
      KeyPair kp = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
      AppProperties props = new AppProperties();
      AppProperties.SigningKey sk = new AppProperties.SigningKey();
      sk.setKid(kid);
      sk.setPrivateKey(Base64.getEncoder().encodeToString(kp.getPrivate().getEncoded()));
      sk.setPublicKey(Base64.getEncoder().encodeToString(kp.getPublic().getEncoded()));
      sk.setActive(true);
      props.getLicensing().setKeys(new ArrayList<>(List.of(sk)));
      return props;
    } catch (Exception e) {
      throw new RuntimeException("failed to generate Ed25519 test key", e);
    }
  }
}
