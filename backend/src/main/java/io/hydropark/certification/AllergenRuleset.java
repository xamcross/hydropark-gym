package io.hydropark.certification;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Deterministic, NON-MODEL Big-9 allergen scanner (P1-20.4, SPEC §28.1) — the server-side, Java port
 * of the harness's {@code eval/allergen.py}, which itself is the mirror of the shipped Rust matcher
 * ({@code client/src-tauri/src/skills/allergen/mod.rs}). All three read the ONE canonical
 * allergen→trigger-term map ({@code allergens.json}); this class loads the backend's shipped copy of
 * that file, which {@link AllergenDataInSyncTest} pins byte-for-behaviour to the client's canonical
 * source so the certification gate provably scores against the exact data the product ships.
 *
 * <p>SAFETY CONTRACT: the model is NEVER trusted for allergen safety. This layer optimises RECALL
 * over precision — a false warning is a nuisance, a missed allergen is a safety failure — so hidden
 * sources are deliberately caught (casein→milk, tahini→sesame, marzipan→tree_nuts, whey→milk,
 * shrimp paste→shellfish, worcestershire→fish, edamame→soy, …).
 *
 * <p>The matcher mirrors the Python/Rust behaviour exactly: whole-word, case-insensitive, with
 * ASCII-alphanumeric word boundaries. That is why {@code "egg"} does not fire on {@code "eggplant"}
 * and {@code "fish"} does not fire on {@code "shellfish"}. Multi-word terms (e.g. {@code "soy sauce"})
 * are supported.
 */
public final class AllergenRuleset {

  private static final String DATA_RESOURCE = "/certification/allergens.json";

  private static final class Holder {
    private static final AllergenRuleset DEFAULT = new AllergenRuleset(loadDefaultData());
  }

  /** One Big-9 allergen entry: its display label and the (lowercased) trigger terms. */
  private record Entry(String display, List<String> terms) {}

  private final int version;
  private final List<String> big9;
  /** Preserves Big-9 order so {@link #scan} is order-stable, exactly like the Python layer. */
  private final Map<String, Entry> allergens;

  AllergenRuleset(JsonNode data) {
    this.version = data.path("version").asInt(0);
    List<String> keys = new ArrayList<>();
    JsonNode big9Node = data.path("big9");
    if (big9Node.isArray()) {
      for (JsonNode k : big9Node) {
        keys.add(k.asText());
      }
    }
    this.big9 = List.copyOf(keys);

    Map<String, Entry> map = new LinkedHashMap<>();
    JsonNode allergensNode = data.path("allergens");
    for (String key : keys) {
      JsonNode entry = allergensNode.path(key);
      if (entry.isMissingNode()) {
        continue;
      }
      String display = entry.path("display").asText(key);
      List<String> terms = new ArrayList<>();
      JsonNode termsNode = entry.path("terms");
      if (termsNode.isArray()) {
        for (JsonNode t : termsNode) {
          terms.add(t.asText().toLowerCase(Locale.ROOT));
        }
      }
      map.put(key, new Entry(display, List.copyOf(terms)));
    }
    this.allergens = Map.copyOf(map);
  }

  /** The shared, canonical ruleset loaded from the classpath (loaded once). */
  public static AllergenRuleset getDefault() {
    return Holder.DEFAULT;
  }

  public int version() {
    return version;
  }

  /** The Big-9 keys in canonical order. */
  public List<String> big9() {
    return big9;
  }

  /** The (lowercased) trigger terms declared for {@code allergenKey}, or empty if unknown. */
  public List<String> terms(String allergenKey) {
    Entry e = allergens.get(allergenKey);
    return e == null ? List.of() : e.terms();
  }

  /** Human display label for an allergen key (e.g. {@code "tree_nuts"} → {@code "Tree nuts"}). */
  public String display(String allergenKey) {
    Entry e = allergens.get(allergenKey);
    return e == null ? allergenKey : e.display();
  }

  /**
   * Every Big-9 allergen triggered by {@code text}. Deterministic and order-stable (Big-9 order); at
   * most one flag per allergen (the first term that fires), mirroring {@code eval/allergen.py:scan}.
   */
  public List<AllergenFlag> scan(String text) {
    List<AllergenFlag> flags = new ArrayList<>();
    if (text == null || text.isEmpty()) {
      return flags;
    }
    String lower = text.toLowerCase(Locale.ROOT);
    for (String key : big9) {
      Entry entry = allergens.get(key);
      if (entry == null) {
        continue;
      }
      for (String term : entry.terms()) {
        if (containsWord(lower, term)) {
          flags.add(new AllergenFlag(key, entry.display(), term));
          break;
        }
      }
    }
    return flags;
  }

  /** The set of allergen keys triggered by {@code text}. */
  public List<String> flaggedAllergens(String text) {
    List<AllergenFlag> flags = scan(text);
    List<String> keys = new ArrayList<>(flags.size());
    for (AllergenFlag f : flags) {
      keys.add(f.allergen());
    }
    return keys;
  }

  /**
   * Whole-word, case-insensitive containment. Both arguments MUST already be lowercased. {@code
   * needle} may contain spaces (multi-word terms). Byte-for-behaviour identical to {@code
   * eval/allergen.py:contains_word}: overlap-safe, with ASCII-alphanumeric boundaries.
   */
  static boolean containsWord(String haystack, String needle) {
    if (needle.isEmpty()) {
      return false;
    }
    int n = needle.length();
    int hayLen = haystack.length();
    int start = 0;
    while (true) {
      int i = haystack.indexOf(needle, start);
      if (i < 0) {
        return false;
      }
      int j = i + n;
      boolean leftOk = i == 0 || !isWordChar(haystack.charAt(i - 1));
      boolean rightOk = j == hayLen || !isWordChar(haystack.charAt(j));
      if (leftOk && rightOk) {
        return true;
      }
      start = i + 1; // overlap-safe
    }
  }

  /** ASCII alphanumeric — matches Python {@code ch.isascii() and ch.isalnum()} (no underscore). */
  private static boolean isWordChar(char c) {
    return c < 128 && Character.isLetterOrDigit(c);
  }

  static JsonNode loadDefaultData() {
    try (InputStream in = AllergenRuleset.class.getResourceAsStream(DATA_RESOURCE)) {
      if (in == null) {
        throw new IllegalStateException("missing classpath resource " + DATA_RESOURCE);
      }
      return new ObjectMapper().readTree(in);
    } catch (IOException e) {
      throw new UncheckedIOException("failed to load canonical allergen data", e);
    }
  }
}
