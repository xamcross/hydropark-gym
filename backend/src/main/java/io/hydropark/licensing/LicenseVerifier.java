package io.hydropark.licensing;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.hydropark.config.AppProperties;
import java.nio.charset.StandardCharsets;
import java.security.PublicKey;
import java.security.Signature;
import java.util.Base64;
import org.springframework.stereotype.Component;

/**
 * Verifies a license token the way the offline client must (BACKEND-DESIGN §6.1): <b>verify the
 * signature over the exact received bytes, and only then JSON-parse the payload.</b> There is no
 * canonical-JSON step, no re-serialization, and no clock - {@code exp} is {@code null} and a
 * perpetual license is valid forever as long as its {@code kid} is still trusted.
 *
 * <p>This server-side copy exists for the round-trip test and for any internal re-check; it is the
 * reference the Angular/Tauri client mirrors (see {@code docs/LICENSE-FORMAT.md}). The parsed
 * {@link LicensePayload} is returned <em>only</em> after the signature and field checks pass.
 */
@Component
public class LicenseVerifier {

  private static final Base64.Decoder B64URL = Base64.getUrlDecoder();

  private final TrustedKeySet keys;
  private final String expectedIssuer;
  private final ObjectMapper json = new ObjectMapper();

  public LicenseVerifier(TrustedKeySet keys, AppProperties props) {
    this.keys = keys;
    this.expectedIssuer = props.getLicensing().getIssuerClaim();
  }

  public LicensePayload verify(String token) {
    if (token == null) {
      throw new LicenseVerificationException("null token");
    }
    String[] parts = token.split("\\.", -1);
    if (parts.length != 3 || parts[0].isEmpty() || parts[1].isEmpty() || parts[2].isEmpty()) {
      throw new LicenseVerificationException("not a compact JWS (expected header.payload.signature)");
    }

    // The signature covers exactly these received bytes - never a re-encoding of them.
    byte[] signingInput = (parts[0] + "." + parts[1]).getBytes(StandardCharsets.US_ASCII);

    JsonNode header = decodeJson(parts[0], "header");
    requireEquals(header, "alg", "EdDSA");
    requireEquals(header, "typ", "hp-lic+jws");
    String kid = text(header, "kid");
    if (kid == null) {
      throw new LicenseVerificationException("header missing kid");
    }

    PublicKey pub =
        keys.verifierFor(kid)
            .orElseThrow(
                () -> new LicenseVerificationException("untrusted or rolled-off kid: " + kid));

    byte[] sig;
    try {
      sig = B64URL.decode(parts[2]);
    } catch (IllegalArgumentException e) {
      throw new LicenseVerificationException("malformed signature segment", e);
    }
    if (!ed25519Verify(pub, signingInput, sig)) {
      throw new LicenseVerificationException("bad signature for kid " + kid);
    }

    // Only now do we trust the payload enough to parse it.
    JsonNode p = decodeJson(parts[1], "payload");
    if (!expectedIssuer.equals(text(p, "iss"))) {
      throw new LicenseVerificationException("unexpected issuer");
    }
    if (!"perpetual".equals(text(p, "entitlement"))) {
      throw new LicenseVerificationException("unexpected entitlement");
    }
    if (p.has("exp") && !p.get("exp").isNull()) {
      throw new LicenseVerificationException("perpetual license must carry exp:null");
    }
    for (String required : new String[] {"license_id", "sub", "skill_id", "device_id"}) {
      if (text(p, required) == null) {
        throw new LicenseVerificationException("payload missing " + required);
      }
    }

    return new LicensePayload(
        text(p, "license_id"),
        text(p, "sub"),
        text(p, "skill_id"),
        text(p, "version_constraint"),
        text(p, "entitlement"),
        text(p, "device_id"),
        text(p, "device_binding"),
        p.path("max_devices").asInt(0),
        p.path("iat").asLong(0),
        null,
        text(p, "iss"));
  }

  private JsonNode decodeJson(String segment, String which) {
    try {
      return json.readTree(B64URL.decode(segment));
    } catch (Exception e) {
      throw new LicenseVerificationException("malformed " + which + " segment", e);
    }
  }

  private static void requireEquals(JsonNode node, String field, String expected) {
    if (!expected.equals(text(node, field))) {
      throw new LicenseVerificationException("unexpected " + field + " (want " + expected + ")");
    }
  }

  private static String text(JsonNode node, String field) {
    JsonNode v = node.get(field);
    return v == null || v.isNull() ? null : v.asText();
  }

  private static boolean ed25519Verify(PublicKey pub, byte[] signingInput, byte[] sig) {
    try {
      Signature s = Signature.getInstance("Ed25519");
      s.initVerify(pub);
      s.update(signingInput);
      return s.verify(sig);
    } catch (Exception e) {
      throw new LicenseVerificationException("verification error", e);
    }
  }
}
