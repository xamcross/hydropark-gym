package io.hydropark.signing;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import java.security.KeyPairGenerator;
import java.security.PublicKey;
import org.junit.jupiter.api.Test;

/**
 * The PKCS#11 signer is a <b>gated skeleton</b> (P1-16.8): until a provider is configured it must
 * refuse to sign with a clear, actionable message rather than silently doing nothing or falling back
 * to software keys. It still reports the active key (whose public half ships in apps regardless of
 * where the private half lives).
 */
class Pkcs11Ed25519SignerTest {

  private static PublicKey somePublicKey() throws Exception {
    return KeyPairGenerator.getInstance("Ed25519").generateKeyPair().getPublic();
  }

  @Test
  void unconfiguredProviderRefusesToSignWithADocumentedMessage() throws Exception {
    SigningKeyRef ref = new SigningKeyRef("hp-lic-hsm", somePublicKey());
    SigningProperties.Pkcs11 cfg = new SigningProperties.Pkcs11(); // all blank => unconfigured
    Signer signer = new Pkcs11Ed25519Signer(ref, cfg);

    assertThat(cfg.isConfigured()).isFalse();
    assertThat(signer.activeKey()).isEqualTo(ref);
    assertThatThrownBy(() -> signer.sign("x".getBytes(StandardCharsets.US_ASCII), ref))
        .isInstanceOf(UnsupportedOperationException.class)
        .hasMessageContaining("configure a PKCS#11 provider")
        .hasMessageContaining("HSM-MIGRATION.md");
  }

  @Test
  void aLibraryPathMarksItConfigured() {
    SigningProperties.Pkcs11 cfg = new SigningProperties.Pkcs11();
    assertThat(cfg.isConfigured()).isFalse();
    cfg.setLibrary("/usr/lib/pkcs11/yubihsm_pkcs11.so");
    assertThat(cfg.isConfigured()).isTrue();
  }
}
