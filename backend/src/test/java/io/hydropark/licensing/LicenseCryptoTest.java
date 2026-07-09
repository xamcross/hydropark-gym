package io.hydropark.licensing;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import io.hydropark.config.AppProperties;
import org.junit.jupiter.api.Test;

/**
 * The signer/verifier round-trip and its tamper-evidence - the property the whole offline licensing
 * model rests on. Pure JUnit: no Spring, no Mongo, just a generated Ed25519 keypair.
 */
class LicenseCryptoTest {

  private LicenseSigner signerFor(AppProperties props) {
    return new LicenseSigner(new TrustedKeySet(props), props);
  }

  private LicenseVerifier verifierFor(AppProperties props) {
    return new LicenseVerifier(new TrustedKeySet(props), props);
  }

  @Test
  void signThenVerifyRoundTrips() {
    AppProperties props = LicensingTestKeys.propsWithFreshKey("hp-lic-test");
    LicenseSigner signer = signerFor(props);
    LicenseVerifier verifier = verifierFor(props);

    LicenseSigner.Signed signed =
        signer.sign("lic_round", "user_123", "cooking-assistant", "dev_ab12", "fp-coarse");

    LicensePayload p = verifier.verify(signed.token());

    assertThat(signed.token().split("\\.")).hasSize(3);
    assertThat(signed.kid()).isEqualTo("hp-lic-test");
    assertThat(p.licenseId()).isEqualTo("lic_round");
    assertThat(p.sub()).isEqualTo("user_123");
    assertThat(p.skillId()).isEqualTo("cooking-assistant");
    assertThat(p.deviceId()).isEqualTo("dev_ab12");
    assertThat(p.deviceBinding()).isEqualTo("fp-coarse");
    assertThat(p.entitlement()).isEqualTo("perpetual");
    assertThat(p.exp()).isNull();
    assertThat(p.iss()).isEqualTo("hydropark-licensing");
    assertThat(p.maxDevices()).isEqualTo(5);
  }

  @Test
  void aSingleFlippedByteInThePayloadFailsVerification() {
    AppProperties props = LicensingTestKeys.propsWithFreshKey("hp-lic-test");
    LicenseSigner signer = signerFor(props);
    LicenseVerifier verifier = verifierFor(props);

    String token =
        signer.sign("lic_tamper", "user_123", "cooking-assistant", "dev_ab12", "fp").token();

    String[] parts = token.split("\\.");
    char c = parts[1].charAt(0);
    char flipped = (c == 'A') ? 'B' : 'A'; // a different valid base64url char -> different bytes
    String tamperedPayload = flipped + parts[1].substring(1);
    String tampered = parts[0] + "." + tamperedPayload + "." + parts[2];

    assertThatThrownBy(() -> verifier.verify(tampered))
        .isInstanceOf(LicenseVerificationException.class);
  }

  @Test
  void anUnknownKidIsRejected() {
    // Sign under one key, verify against a trust set that only knows a different key.
    AppProperties signingProps = LicensingTestKeys.propsWithFreshKey("hp-lic-A");
    AppProperties trustingProps = LicensingTestKeys.propsWithFreshKey("hp-lic-B");

    String token = signerFor(signingProps).sign("lic_x", "u", "s", "d", "fp").token();

    assertThatThrownBy(() -> verifierFor(trustingProps).verify(token))
        .isInstanceOf(LicenseVerificationException.class);
  }
}
