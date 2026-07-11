package io.hydropark.packaging;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Deterministic canonicalization of a {@code .hpskill} manifest for <b>package signing</b> (SPEC
 * §8.8, BACKEND-DESIGN §6.2 B8). This is the package-signing analogue of the license path — but with
 * the opposite design choice, and for a good reason.
 *
 * <p>The license signer signs the exact received bytes and never canonicalizes (LicenseSigner §6.1
 * B3), because a token is minted once and shipped verbatim as a compact JWS. A skill manifest is
 * different: it is authored, then the registry <b>injects</b> the {@code signature} and {@code
 * signing_key_id} fields into the very object being signed, and the manifest is stored/transmitted as
 * pretty JSON that may be re-parsed and re-serialized before verification. So the signed bytes must be
 * a canonical form that is insensitive to (a) the two signature fields themselves and (b) object key
 * order and whitespace.
 *
 * <p><b>The canonical form</b> is: deep-copy the manifest, remove the top-level {@link #SIGNATURE_FIELD}
 * and {@link #SIGNING_KEY_ID_FIELD} (a signature cannot cover itself), recursively rebuild every object
 * with its keys sorted lexicographically (arrays keep their order — array order is semantic in JSON),
 * and serialize compactly with Jackson. Because both {@link PackageSigner} and {@link
 * PackageSignatureVerifier} call this same pure function, sign and verify agree by construction.
 *
 * <p><b>Assumption (documented):</b> this is a structural canonicalization, not a full JCS (RFC 8785)
 * number/string normalization. It relies on scalar tokens being represented consistently between sign
 * and verify — which holds because the registry controls packaging and the manifest round-trips
 * through Jackson on both ends. Two different textual encodings of the same number ({@code 500} vs
 * {@code 5e2}) would canonicalize differently; the registry never emits such variance.
 */
public final class ManifestCanonicalizer {

  /** The detached package signature (base64), excluded from the bytes it signs. */
  public static final String SIGNATURE_FIELD = "signature";

  /** The id of the package-signing key that produced {@link #SIGNATURE_FIELD}; also excluded. */
  public static final String SIGNING_KEY_ID_FIELD = "signing_key_id";

  private static final ObjectMapper MAPPER = new ObjectMapper();

  private ManifestCanonicalizer() {}

  /**
   * The canonical bytes to sign / verify: the manifest with the two signature fields removed and all
   * object keys recursively sorted, serialized compactly.
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
      return MAPPER.writeValueAsBytes(sortRecursively(copy));
    } catch (JsonProcessingException e) {
      throw new IllegalStateException("failed to canonicalize manifest", e);
    }
  }

  private static JsonNode sortRecursively(JsonNode node) {
    if (node.isObject()) {
      List<String> names = new ArrayList<>();
      node.fieldNames().forEachRemaining(names::add);
      Collections.sort(names);
      ObjectNode out = JsonNodeFactory.instance.objectNode();
      for (String name : names) {
        out.set(name, sortRecursively(node.get(name)));
      }
      return out;
    }
    if (node.isArray()) {
      ArrayNode out = JsonNodeFactory.instance.arrayNode();
      for (JsonNode child : node) {
        out.add(sortRecursively(child));
      }
      return out;
    }
    return node; // scalars are reproduced verbatim
  }
}
