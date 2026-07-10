package io.hydropark.licensing;

import io.hydropark.signing.Es256Signer;
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
 * licensing {@link TrustedKeySet} (which parses the signing keys from config) into the signer-neutral
 * {@code io.hydropark.signing} package. The dependency direction is deliberately one-way — {@code
 * licensing → signing}, never back — so the signing package stays a leaf and the module graph has no
 * cycle. (This is the one cross-package import this ticket introduces, both packages being owned by
 * the same ticket; the seam is the point.)
 *
 * <p>Gated on {@code hydropark.issuer.enabled=true}: only the isolated issuer zone holds signing
 * material, so only there is a {@code Signer} bean created.
 *
 * <p><b>Signer selection is by the active key's algorithm (P1-16.8).</b> The active {@link
 * TrustedKeySet} key is tagged {@code ES256} or {@code EdDSA}:
 *
 * <ul>
 *   <li>{@code ES256} → {@link Es256Signer} (in-memory ECDSA P-256; the current default for new
 *       issuance).
 *   <li>{@code EdDSA} → {@link JdkEd25519Signer} (in-memory) or, when {@code
 *       hydropark.signing.provider=pkcs11}, {@link Pkcs11Ed25519Signer} (hardware HSM, option (a)).
 * </ul>
 *
 * The {@code hydropark.signing.provider} switch therefore only selects the <em>custody backend for
 * the EdDSA path</em>; the <em>algorithm</em> is driven by the active key so a config that flips the
 * active key to an ES256 entry automatically signs ES256.
 */
@Configuration
@ConditionalOnProperty(name = "hydropark.issuer.enabled", havingValue = "true")
public class SignerConfig {

  // Bean name is `activeSigner`, NOT `licenseSigner`: this method returns the low-level
  // io.hydropark.signing.Signer, whereas LicenseSigner is a @Component-scanned class whose default
  // bean name is `licenseSigner`. Naming this method `licenseSigner` collided with that component and
  // crashed the issuer zone at context refresh (both beans present there) - while the api zone booted
  // fine because this config is @ConditionalOnProperty(issuer.enabled). Injection is by type, so the
  // name is free to change. Caught only by booting the real issuer zone; no unit test exercises it.
  @Bean
  Signer activeSigner(TrustedKeySet keys, SigningProperties props) {
    // activeKeyOrEmpty() does not require a private half here — it is only used to read the pinned
    // alg + kid; the concrete factory below asserts the private half when the path needs it.
    TrustedKeySet.TrustedKey active =
        keys.activeKeyOrEmpty()
            .orElseThrow(
                () ->
                    new IllegalStateException(
                        "no active signing key configured — exactly one hydropark.licensing.keys"
                            + " entry must be active"));
    String alg = active.alg();
    return switch (alg) {
      case "ES256" -> es256SignerFrom(keys);
      case "EdDSA" -> {
        if ("pkcs11".equalsIgnoreCase(props.getProvider())) {
          yield new Pkcs11Ed25519Signer(
              new SigningKeyRef(active.kid(), active.publicKey()), props.getPkcs11());
        }
        yield jdkSignerFrom(keys);
      }
      default ->
          throw new IllegalStateException(
              "unsupported active signing key alg: " + alg + " (kid=" + active.kid() + ")");
    };
  }

  /**
   * Builds the {@link Signer} for the active key's algorithm from a {@link TrustedKeySet}, without a
   * Spring context or the PKCS#11 backend. Public + static so a unit test can construct exactly the
   * in-memory signer the container wires (ES256 or EdDSA), driven off the same active-key tag.
   */
  public static Signer signerFrom(TrustedKeySet keys) {
    String alg = keys.active().alg();
    return switch (alg) {
      case "ES256" -> es256SignerFrom(keys);
      case "EdDSA" -> jdkSignerFrom(keys);
      default -> throw new IllegalStateException("unsupported active signing key alg: " + alg);
    };
  }

  /**
   * Bridges a {@link TrustedKeySet} to an in-memory Ed25519 signer. {@link TrustedKeySet#active()} is
   * used (not the private-tolerant accessor) so the JDK path keeps its fail-fast behaviour: if the
   * active key has no private half on this zone, construction throws.
   */
  public static Signer jdkSignerFrom(TrustedKeySet keys) {
    TrustedKeySet.TrustedKey active = keys.active();
    return new JdkEd25519Signer(
        new SigningKeyRef(active.kid(), active.publicKey()), privateKeysByKid(keys));
  }

  /** Bridges a {@link TrustedKeySet} to an in-memory ES256 (ECDSA P-256) signer. */
  public static Signer es256SignerFrom(TrustedKeySet keys) {
    TrustedKeySet.TrustedKey active = keys.active();
    return new Es256Signer(
        new SigningKeyRef(active.kid(), active.publicKey()), privateKeysByKid(keys));
  }

  private static Map<String, PrivateKey> privateKeysByKid(TrustedKeySet keys) {
    Map<String, PrivateKey> privateKeysByKid = new LinkedHashMap<>();
    for (TrustedKeySet.TrustedKey k : keys.keys()) {
      if (k.privateKey() != null) {
        privateKeysByKid.put(k.kid(), k.privateKey());
      }
    }
    return privateKeysByKid;
  }
}
