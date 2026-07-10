package io.hydropark.licensing;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.hydropark.config.AppProperties;
import io.hydropark.signing.EcdsaP1363;
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
 * <p><b>Algorithm is pinned per {@code kid}, never taken from the header (P1-16.8, alg-confusion
 * defense).</b> New tokens are {@code ES256} (ECDSA P-256); older deployed tokens are {@code EdDSA}
 * (Ed25519). The verifier reads {@code kid}, looks up that key in the trusted set, and verifies with
 * <b>the algorithm that key record declares</b> — not with whatever the JWS header claims. It
 * additionally asserts the header {@code alg} equals the key's pinned algorithm and <b>fails closed</b>
 * on any disagreement (an ES256 kid presented as {@code alg:EdDSA}, or vice versa). The header's
 * {@code alg} never selects the verify algorithm.
 *
 * <p>For ES256 the on-the-wire signature is the fixed 64-byte {@code R||S} (RFC 7518 §3.4); the JDK's
 * {@code SHA256withECDSA} needs DER, so it is converted via {@link EcdsaP1363} — and a non-64-byte
 * ES256 signature is rejected outright.
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
    requireEquals(header, "typ", "hp-lic+jws");
    String kid = text(header, "kid");
    if (kid == null) {
      throw new LicenseVerificationException("header missing kid");
    }

    // Pin the algorithm to the trusted key for this kid — the header does NOT get to choose it.
    TrustedKeySet.TrustedKey trusted =
        keys.trustedKeyFor(kid)
            .orElseThrow(
                () -> new LicenseVerificationException("untrusted or rolled-off kid: " + kid));
    String pinnedAlg = trusted.alg();

    // Defense in depth: the header alg must match the pinned alg. Fail closed on any mismatch
    // (alg-confusion: an ES256 kid presented as alg:EdDSA, or vice versa). Done before touching the
    // signature so a confused token is rejected even if its bytes happen to be validly signed.
    String headerAlg = text(header, "alg");
    if (headerAlg == null || !headerAlg.equals(pinnedAlg)) {
      throw new LicenseVerificationException(
          "alg mismatch: header alg '" + headerAlg + "' != pinned alg '" + pinnedAlg + "' for kid " + kid);
    }

    PublicKey pub = trusted.publicKey();

    byte[] sig;
    try {
      sig = B64URL.decode(parts[2]);
    } catch (IllegalArgumentException e) {
      throw new LicenseVerificationException("malformed signature segment", e);
    }

    boolean ok =
        switch (pinnedAlg) {
          case "ES256" -> es256Verify(pub, signingInput, sig);
          case "EdDSA" -> ed25519Verify(pub, signingInput, sig);
          default -> throw new LicenseVerificationException("unsupported pinned alg: " + pinnedAlg);
        };
    if (!ok) {
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

  /**
   * ES256 verify. The JWS signature is the fixed 64-byte {@code R||S} (RFC 7518 §3.4); a P-256 raw
   * signature is <b>exactly 64 bytes</b>, so anything else is rejected before we touch it. The JDK's
   * {@code SHA256withECDSA} consumes DER, so we convert {@code R||S} → DER first.
   */
  private static boolean es256Verify(PublicKey pub, byte[] signingInput, byte[] sig) {
    if (sig.length != 64) {
      throw new LicenseVerificationException(
          "ES256 signature must be 64-byte P1363 R||S, got " + sig.length + " bytes");
    }
    try {
      byte[] der = EcdsaP1363.concatToDer(sig);
      Signature s = Signature.getInstance("SHA256withECDSA");
      s.initVerify(pub);
      s.update(signingInput);
      return s.verify(der);
    } catch (LicenseVerificationException e) {
      throw e;
    } catch (Exception e) {
      throw new LicenseVerificationException("ES256 verification error", e);
    }
  }
}
