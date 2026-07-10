package io.hydropark.licensing;

import io.hydropark.signing.JdkEd25519Signer;
import io.hydropark.signing.Pkcs11Ed25519Signer;
import io.hydropark.signing.Signer;
import io.hydropark.signing.SigningKeyRef;
import io.hydropark.signing.SigningProperties;
import java.security.PrivateKey;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Wires the active {@link Signer} for the issuer zone and is the <b>single bridge</b> from the
 * licensing {@link TrustedKeySet} (which parses the Ed25519 keys from config) into the signer-neutral
 * {@code io.hydropark.signing} package. The dependency direction is deliberately one-way — {@code
 * licensing → signing}, never back — so the signing package stays a leaf and the module graph has no
 * cycle. (This is the one cross-package import this ticket introduces, both packages being owned by
 * the same ticket; the seam is the point.)
 *
 * <p>Gated on {@code hydropark.issuer.enabled=true}: only the isolated issuer zone holds signing
 * material, so only there is a {@code Signer} bean created. Which implementation is chosen by {@code
 * hydropark.signing.provider} — {@code jdk} (default) or {@code pkcs11}.
 */
@Configuration
@ConditionalOnProperty(name = "hydropark.issuer.enabled", havingValue = "true")
public class SignerConfig {

  /**
   * Default: the in-memory JDK-native signer (interim custody, P1-16.3). {@code matchIfMissing} keeps
   * {@code jdk} the default when {@code hydropark.signing.provider} is unset.
   */
  @Bean
  @ConditionalOnProperty(name = "hydropark.signing.provider", havingValue = "jdk", matchIfMissing = true)
  Signer jdkEd25519Signer(TrustedKeySet keys) {
    return jdkSignerFrom(keys);
  }

  /**
   * Opt-in: the hardware-HSM PKCS#11 signer (P1-16.8, option (a)). The active key's public half comes
   * from config as usual (it must ship in apps); the private half is addressed in the token by label
   * and never parsed here — so {@link TrustedKeySet#activeKeyOrEmpty()}, which does not require a
   * private half, is used.
   */
  @Bean
  @ConditionalOnProperty(name = "hydropark.signing.provider", havingValue = "pkcs11")
  Signer pkcs11Ed25519Signer(TrustedKeySet keys, SigningProperties props) {
    TrustedKeySet.TrustedKey active =
        keys.activeKeyOrEmpty()
            .orElseThrow(
                () ->
                    new IllegalStateException(
                        "no active signing key configured — exactly one hydropark.licensing.keys"
                            + " entry must be active"));
    return new Pkcs11Ed25519Signer(
        new SigningKeyRef(active.kid(), active.publicKey()), props.getPkcs11());
  }

  /**
   * Bridges a {@link TrustedKeySet} to a JDK signer. Public + static so a unit test can build exactly
   * the signer the container wires, without a Spring context. {@link TrustedKeySet#active()} is used
   * (not the private-tolerant accessor) so the JDK path keeps its original fail-fast behaviour: if
   * the active key has no private half on this zone, construction throws — as it did before the seam.
   */
  public static Signer jdkSignerFrom(TrustedKeySet keys) {
    TrustedKeySet.TrustedKey active = keys.active();
    Map<String, PrivateKey> privateKeysByKid = new LinkedHashMap<>();
    for (TrustedKeySet.TrustedKey k : keys.keys()) {
      if (k.privateKey() != null) {
        privateKeysByKid.put(k.kid(), k.privateKey());
      }
    }
    return new JdkEd25519Signer(
        new SigningKeyRef(active.kid(), active.publicKey()), privateKeysByKid);
  }
}
