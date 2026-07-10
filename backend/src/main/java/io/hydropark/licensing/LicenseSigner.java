package io.hydropark.licensing;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.hydropark.config.AppProperties;
import io.hydropark.signing.Signer;
import io.hydropark.signing.SigningKeyRef;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/**
 * The sacred signer (BACKEND-DESIGN §6.1). Mints the license as a <b>compact, attached JWS</b> with
 * {@code alg: EdDSA} (Ed25519), signing over the exact ASCII bytes
 * {@code base64url(header) || '.' || base64url(payload)}.
 *
 * <p>Deliberate choices, each load-bearing:
 *
 * <ul>
 *   <li><b>The raw Ed25519 signature goes through a {@link Signer}</b> (P1-16.8) — the one seam an
 *       HSM/KMS backend slots into. The default {@code io.hydropark.signing.JdkEd25519Signer} is the
 *       original JDK-native path ({@code Signature.getInstance("Ed25519")}), <em>not</em> Nimbus,
 *       which pulls in Tink; the access-token path uses Nimbus/RSA and must never share a key or a
 *       library assumption with this one. A token minted through the JDK signer is byte-for-byte
 *       identical to what the old inline code produced.
 *   <li><b>No canonical JSON.</b> The bytes we sign are the bytes the client verifies. There is no
 *       re-serialization step anywhere, so no "canonical JSON" disagreement can ever brick a valid
 *       license (§6.1 B3). This class — not the {@code Signer} — owns the token format, so swapping
 *       the signer never changes a byte of the format.
 *   <li>base64url <b>without padding</b>.
 * </ul>
 *
 * <p>Gated on {@code hydropark.issuer.enabled=true}: only the isolated issuer zone holds signing
 * material, so only there does this bean exist. The private key is never logged, echoed, or returned.
 */
@Component
@ConditionalOnProperty(name = "hydropark.issuer.enabled", havingValue = "true")
public class LicenseSigner {

  /** A freshly minted token plus the kid that signed it. */
  public record Signed(String token, String kid) {}

  private static final Base64.Encoder B64URL = Base64.getUrlEncoder().withoutPadding();

  private final Signer signer;
  private final AppProperties.Licensing cfg;
  private final ObjectMapper json = new ObjectMapper();

  public LicenseSigner(Signer signer, AppProperties props) {
    this.signer = signer;
    this.cfg = props.getLicensing();
  }

  /** Mint a fresh perpetual license for a device, under the current active key. */
  public Signed sign(
      String licenseId, String sub, String skillId, String deviceId, String deviceBinding) {
    LicensePayload payload =
        new LicensePayload(
            licenseId,
            sub,
            skillId,
            ">=1.0.0",
            "perpetual",
            deviceId,
            deviceBinding,
            cfg.getMaxDevices(),
            Instant.now().getEpochSecond(),
            null, // exp: perpetual
            cfg.getIssuerClaim());
    return signPayload(payload);
  }

  /**
   * Sign an explicit payload - used by rolling-key re-issue, which preserves a token's bindings but
   * mints a new {@code license_id} + {@code iat} under the newest key.
   */
  public Signed signPayload(LicensePayload p) {
    SigningKeyRef active = signer.activeKey();

    Map<String, Object> header = new LinkedHashMap<>();
    header.put("alg", "EdDSA");
    header.put("kid", active.kid());
    header.put("typ", "hp-lic+jws");

    Map<String, Object> payload = new LinkedHashMap<>();
    payload.put("license_id", p.licenseId());
    payload.put("sub", p.sub());
    payload.put("skill_id", p.skillId());
    payload.put("version_constraint", p.versionConstraint());
    payload.put("entitlement", p.entitlement());
    payload.put("device_id", p.deviceId());
    payload.put("device_binding", p.deviceBinding());
    payload.put("max_devices", p.maxDevices());
    payload.put("iat", p.iat());
    payload.put("exp", p.exp()); // null -> "exp":null
    payload.put("iss", p.iss());

    String signingInput = B64URL.encodeToString(toBytes(header)) + "." + B64URL.encodeToString(toBytes(payload));
    // The one line that differs between in-memory keys and a hardware HSM: the raw signature over
    // these exact bytes. Everything else in this method is signer-independent token assembly.
    byte[] sig = signer.sign(signingInput.getBytes(StandardCharsets.US_ASCII), active);
    String token = signingInput + "." + B64URL.encodeToString(sig);
    return new Signed(token, active.kid());
  }

  private byte[] toBytes(Map<String, Object> node) {
    try {
      return json.writeValueAsBytes(node);
    } catch (Exception e) {
      throw new IllegalStateException("failed to serialize license segment", e);
    }
  }
}
