package io.hydropark.packaging;

import io.hydropark.signing.JdkEd25519Signer;
import io.hydropark.signing.Signer;
import io.hydropark.signing.SigningKeyRef;
import java.security.PrivateKey;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Wires the {@link PackageSigner} for the registry/signing zone, and is the single bridge from the
 * package {@link PackageTrustedKeySet} into the signer-neutral {@code io.hydropark.signing} package —
 * exactly mirroring how licensing's {@code SignerConfig} bridges its own trusted set, but with a
 * SEPARATE key so the license signer is never a package oracle.
 *
 * <p>Gated on {@code hydropark.package-signing.enabled=true}: only the zone that actually holds the
 * package private half creates a signer bean. Everywhere else there is no {@link PackageSigner} bean,
 * yet {@link PackageSignatureVerifier} still works (it needs only the public keys).
 *
 * <p>Note it produces a {@link PackageSigner} bean, <b>not</b> a bare {@code Signer} bean — a second
 * {@code Signer} bean would make the by-type injection in {@code LicenseSigner} ambiguous. The
 * Ed25519 {@code Signer} it builds is package-scoped and hidden inside the {@link PackageSigner}.
 */
@Configuration
@ConditionalOnProperty(name = "hydropark.package-signing.enabled", havingValue = "true")
public class PackageSignerConfig {

  @Bean
  PackageSigner packageSigner(PackageTrustedKeySet keys) {
    PackageTrustedKeySet.PackageKey active = keys.active(); // asserts a private half is present
    Map<String, PrivateKey> privateKeysByKid = new LinkedHashMap<>();
    for (PackageTrustedKeySet.PackageKey k : keys.keys()) {
      if (k.privateKey() != null) {
        privateKeysByKid.put(k.kid(), k.privateKey());
      }
    }
    Signer signer =
        new JdkEd25519Signer(
            new SigningKeyRef(active.kid(), active.publicKey()), privateKeysByKid);
    return new PackageSigner(signer);
  }
}
