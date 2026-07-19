package io.hydropark.packaging;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import org.erdtman.jcs.JsonCanonicalizer;

/**
 * Deterministic canonicalization of a {@code .hpskill} manifest for <b>package signing</b> (SPEC
 * §8.8, BACKEND-DESIGN §6.2 B8), via <b>RFC 8785 JSON Canonicalization Scheme (JCS)</b>. This is the
 * package-signing analogue of the license path — but with the opposite design choice, and for a good
 * reason.
 *
 * <p>The license signer signs the exact received bytes and never canonicalizes (LicenseSigner §6.1
 * B3), because a token is minted once and shipped verbatim as a compact JWS. A skill manifest is
 * different: it is authored, then the registry <b>injects</b> the {@link #SIGNATURE_FIELD} and {@link
 * #SIGNING_KEY_ID_FIELD} fields into the very object being signed, and the manifest is stored/transmitted
 * as pretty JSON that may be re-parsed and re-serialized before verification. So the signed bytes must
 * be a canonical form that is insensitive to (a) the two signature fields themselves, (b) object key
 * order and whitespace, and (c) the textual encoding of scalars (number formatting, string escaping).
 *
 * <p><b>Cross-language rationale (owner decision).</b> The manifest signature is produced here (Java)
 * and verified in a <b>separate Rust client</b>. Canonicalization must therefore be <em>byte-stable
 * across languages</em>. The prior "Jackson sorted-keys compact" form was <em>not</em>: it reproduced
 * scalar tokens verbatim, so persona strings containing newlines/unicode and differently-formatted
 * numbers ({@code 500} vs {@code 5e2}, {@code 3} vs {@code 3.0}) would serialize differently on the two
 * sides and the signature would fail to verify. RFC 8785 removes that ambiguity: it mandates
 * lexicographic key sorting, minimal string escaping (only {@code "}, {@code \}, and the C0 control
 * range are escaped — non-ASCII is emitted literally), and one canonical number form (ECMAScript
 * shortest round-trip). Both the backend signer and the Rust verifier run the same JCS algorithm, so
 * they agree byte-for-byte. The {@code contracts/testdata/package-signing-golden.json} fixture (see
 * {@code PackageGoldenVectorTest}) pins a canonical string the Rust side diffs against.
 *
 * <p><b>The canonical form</b> is: deep-copy the manifest, remove the top-level {@link #SIGNATURE_FIELD}
 * and {@link #SIGNING_KEY_ID_FIELD} (a signature cannot cover itself), serialize the remainder to a JSON
 * string, and hand that string to {@link JsonCanonicalizer} — which alone performs the RFC 8785 key
 * sort and number/string normalization. We deliberately do <em>not</em> pre-sort or compact with Jackson
 * first; JCS is the single source of canonical order and encoding. Because both {@link PackageSigner}
 * and {@link PackageSignatureVerifier} call this same pure function, sign and verify agree by
 * construction.
 */
public final class ManifestCanonicalizer {

  /** The detached package signature (base64), excluded from the bytes it signs. */
  public static final String SIGNATURE_FIELD = "signature";

  /** The id of the package-signing key that produced {@link #SIGNATURE_FIELD}; also excluded. */
  public static final String SIGNING_KEY_ID_FIELD = "signing_key_id";

  private static final ObjectMapper MAPPER = new ObjectMapper();

  private ManifestCanonicalizer() {}

  /**
   * The canonical bytes to sign / verify: the manifest with the two signature fields removed, then
   * canonicalized per RFC 8785 (JCS) — keys sorted, numbers/strings normalized, no insignificant
   * whitespace — as UTF-8 bytes.
   *
   * @throws IllegalArgumentException if {@code manifest} is not a JSON object
   */
  public static byte[] canonicalBytes(JsonNode manifest) {
    if (manifest == null || !manifest.isObject()) {
      throw new IllegalArgumentException("manifest must be a JSON object");
    }
    ObjectNode copy = (ObjectNode) manifest.deepCopy();
    copy.remove(SIGNATURE_FIELD);
    copy.remove(SIGNING_KEY_ID_FIELD);
    try {
      // Serialize the manifest-minus-signature to a JSON string, then let JCS (and only JCS) impose
      // RFC 8785 key ordering and number/string normalization. getEncodedUTF8() returns the canonical
      // UTF-8 bytes.
      String json = MAPPER.writeValueAsString(copy);
      return new JsonCanonicalizer(json).getEncodedUTF8();
    } catch (IOException e) {
      throw new IllegalStateException("failed to canonicalize manifest", e);
    }
  }
}
