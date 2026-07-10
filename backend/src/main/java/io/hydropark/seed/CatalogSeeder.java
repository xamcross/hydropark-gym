package io.hydropark.seed;

import com.mongodb.client.MongoCollection;
import com.mongodb.client.model.Filters;
import com.mongodb.client.model.ReplaceOptions;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import org.bson.Document;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.core.annotation.Order;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.stereotype.Component;

/**
 * Seeds the initial first-party catalog: the 2 free skills + the paid "home & lifestyle"
 * beachhead skills (SPECIFICATION §, BACKEND-DESIGN §3.2), one {@code home-starter-pack} bundle,
 * and a handful of {@code regional_prices} rows demonstrating PPP pricing.
 *
 * <p><b>Idempotent by construction.</b> Every write here is an upsert keyed by a deterministic
 * {@code _id} (never a blind {@code insertOne}), so running this twice - which WILL happen, since
 * it re-runs on every boot with {@code hydropark.seed.enabled=true} - produces the same documents,
 * not duplicates. {@code skills}/{@code bundles} use their natural slug id (AGENT-CONTRACT
 * convention). {@code skill_versions}, {@code bundle_members}, and {@code regional_prices} have no
 * natural single-field id in the reference schema (their Postgres keys are composite), so this
 * seeder mints a deterministic composite string id for each - intentionally NOT
 * {@link io.hydropark.common.Uuid7#generate()}, which is random per call and would defeat
 * idempotency here. Runtime writers of these collections (outside this seeder) are expected to use
 * UUIDv7 as normal; this is a bootstrap-only exception.
 *
 * <p><b>Never seeds {@code system_prompt}.</b> That field does not even appear below. The full
 * persona is paid IP that lives only inside the signed {@code .hpskill} package (§4.2/SF8) - Mongo
 * only ever holds {@code compressed_prompt}, the short pre-purchase teaser text (reused here from
 * the actual landing-gym copy where available).
 *
 * <p>Runs strictly after migrations: {@link io.hydropark.migration.MigrationBootstrap} is ordered
 * first (order 1); this class is ordered second (order 2). See {@code backend/docs/MIGRATIONS.md}
 * for a caveat about this ordering when {@code hydropark.migration.exit-after=true}.
 */
@Component
@Order(2)
@ConditionalOnProperty(name = "hydropark.seed.enabled", havingValue = "true")
public class CatalogSeeder implements ApplicationRunner {

  private static final Logger log = LoggerFactory.getLogger(CatalogSeeder.class);

  /** hydropark.licensing.keys[].kid default in application.yml (dev). Seed packages "sign" under it. */
  private static final String DEV_SIGNING_KEY_ID = "hp-lic-dev";

  private final MongoTemplate mongo;

  public CatalogSeeder(MongoTemplate mongo) {
    this.mongo = mongo;
  }

  @Override
  public void run(ApplicationArguments args) {
    int skills = seedSkills();
    int versions = seedSkillVersions();
    int bundles = seedBundle();
    int members = seedBundleMembers();
    int prices = seedRegionalPrices();
    log.info(
        "catalog seed complete: {} skills, {} skill_versions, {} bundles, {} bundle_members, {} regional_prices",
        skills, versions, bundles, members, prices);
  }

  // ---------------------------------------------------------------------------------------------
  // skills (BACKEND-DESIGN §3.2)
  // ---------------------------------------------------------------------------------------------

  /**
   * The 2 free skills are exactly the ones named in SPECIFICATION as the always-installed free
   * tier (also the two free "plates" on the landing-gym rack). The 8 paid skills at $5 are the 6
   * named in {@code landing-gym/index.html} (cooking-assistant, nutrition-coach, travel-planner,
   * home-diy, garden-plants, car-care) plus 2 more to reach the 8-paid floor
   * (SPRINT-BACKLOG.md §6 / BACKLOG.md §6: picking the final 2 is an explicit open owner/content
   * decision - see the two marked PROVISIONAL below and the seeder's final report).
   */
  private List<SkillSeed> catalog() {
    return List.of(
        // --- free (2) ---
        new SkillSeed(
            // Slug is "kitchen-timer" (matches landing-gym/), NOT "kitchen-timer-units". The
            // display name keeps the "& Units" wording. Every derived value in this seeder
            // (skills._id, skill_versions._id/skill_id/package_uri/package_sha256/signature) is a
            // function of this id, so this single change re-slugs the whole free timer skill.
            // V011RenameKitchenTimerSku re-keys databases seeded under the old slug.
            "kitchen-timer",
            "Kitchen Timer & Units",
            "kitchen",
            true,
            0,
            "Timers and unit conversion."),
        new SkillSeed(
            "packing-list", "Packing List", "travel", true, 0, "Packing lists and trip dates."),

        // --- paid (8), $5 each, base_currency USD ---
        // 6 named in landing-gym/index.html:
        new SkillSeed(
            "cooking-assistant",
            "Cooking Assistant",
            "kitchen",
            false,
            500,
            "Cooking specialist: recipes, substitutions, timers, units."),
        new SkillSeed(
            "nutrition-coach",
            "Nutrition Coach",
            "kitchen",
            false,
            500,
            "Nutrition: calories and macros for the current list. Informational only."),
        new SkillSeed(
            "travel-planner",
            "Travel Planner",
            "travel",
            false,
            500,
            "Travel planning: itineraries, dates, budgets."),
        new SkillSeed(
            "home-diy",
            "Home & DIY",
            "home",
            false,
            500,
            "Home repair: measurements, materials, cut lists."),
        new SkillSeed(
            "garden-plants",
            "Garden & Plants",
            "home",
            false,
            500,
            "Garden care: watering schedules, seasons."),
        new SkillSeed(
            "car-care", "Car Care", "home", false, 500, "Car maintenance: schedules, fluids, service log."),
        // 2 PROVISIONAL additions to reach the 8-paid floor (owner decision still open - flagged
        // in the final report; pick sensible placeholders, do not treat as final content):
        new SkillSeed(
            "cleaning-schedule",
            "Home Cleaning Planner",
            "home",
            false,
            500,
            "PROVISIONAL: Cleaning rotations and reminders, room by room."),
        new SkillSeed(
            "pet-care",
            "Pet Care Companion",
            "home",
            false,
            500,
            "PROVISIONAL: Feeding schedules, vet reminders, and care logs for a pet."));
  }

  private int seedSkills() {
    MongoCollection<Document> coll = mongo.getCollection("skills");
    int count = 0;
    for (SkillSeed s : catalog()) {
      Instant createdAt = existingCreatedAt(coll, s.id());
      Document doc =
          new Document("_id", s.id())
              .append("name", s.name())
              .append("category", s.category())
              .append("is_free", s.free())
              .append("status", "published")
              .append("base_price", s.basePriceMinor())
              .append("base_currency", "USD")
              .append("compressed_prompt", s.compressedPrompt())
              // Never a live curated demo transcript in seed data - left null deliberately.
              .append("preview_transcript_uri", null)
              .append("min_model_tier", "small")
              .append("created_at", createdAt)
              .append("updated_at", Instant.now());
      coll.replaceOne(Filters.eq("_id", s.id()), doc, new ReplaceOptions().upsert(true));
      count++;
    }
    return count;
  }

  // ---------------------------------------------------------------------------------------------
  // skill_versions (BACKEND-DESIGN §3.2)
  // ---------------------------------------------------------------------------------------------

  private int seedSkillVersions() {
    MongoCollection<Document> coll = mongo.getCollection("skill_versions");
    int count = 0;
    for (SkillSeed s : catalog()) {
      String version = "1.0.0";
      // Deterministic composite id so re-seeding upserts the same row instead of colliding with
      // the (skill_id, version) unique index created by V003CreateCatalogIndexes.
      String id = s.id() + "@" + version;
      byte[] digest = sha256((s.id() + "|" + version).getBytes(StandardCharsets.UTF_8));
      String sha256Hex = toHex(digest);
      long packageBytes = 20_000L + (long) s.id().length() * 733L;
      // NOT a real Ed25519 signature - a deterministic, plausible-shaped placeholder for seed
      // data only. Real .hpskill packages are signed offline by the packaging tool; the Issuer
      // never runs here and this seeder holds no private key.
      String placeholderSignature = Base64.getUrlEncoder().withoutPadding().encodeToString(digest);

      Instant createdAt = existingCreatedAt(coll, id);
      Document doc =
          new Document("_id", id)
              .append("skill_id", s.id())
              .append("version", version)
              .append("is_current", true)
              .append("min_app_version", "0.1.0")
              .append("package_uri", "skills/" + s.id() + "/" + version + "/package.hpskill")
              .append("package_sha256", sha256Hex)
              .append("package_bytes", packageBytes)
              .append("signature", placeholderSignature)
              .append("signing_key_id", DEV_SIGNING_KEY_ID)
              .append("changelog", "Initial release.")
              .append("status", "published")
              .append("created_at", createdAt)
              .append("updated_at", Instant.now());
      coll.replaceOne(Filters.eq("_id", id), doc, new ReplaceOptions().upsert(true));
      count++;
    }
    return count;
  }

  // ---------------------------------------------------------------------------------------------
  // bundles + bundle_members (BACKEND-DESIGN §3.2)
  // ---------------------------------------------------------------------------------------------

  private static final String BUNDLE_ID = "home-starter-pack";
  private static final String BUNDLE_NAME = "Home Starter Pack";
  // 3 members at $5 each = $15 (1500); bundle price is strictly below that (§3.2:
  // "bundle_price int NOT NULL, -- minor units, < sum(members)"). $12 matches the landing-gym
  // copy's own stated "themed three-pack is $12" price point and its "Saturday Jobs" preset
  // (home-diy, car-care, garden-plants).
  private static final long BUNDLE_PRICE = 1200;
  private static final List<String> BUNDLE_MEMBER_SKILL_IDS = List.of("home-diy", "garden-plants", "car-care");

  private int seedBundle() {
    MongoCollection<Document> coll = mongo.getCollection("bundles");
    Instant createdAt = existingCreatedAt(coll, BUNDLE_ID);
    long memberSum = BUNDLE_MEMBER_SKILL_IDS.size() * 500L;
    if (BUNDLE_PRICE >= memberSum) {
      // Defensive - would violate §3.2's "< sum(members)" invariant if someone edits the
      // constants above without checking.
      throw new IllegalStateException(
          "home-starter-pack bundle_price (" + BUNDLE_PRICE + ") must be < sum(members) (" + memberSum + ")");
    }
    Document doc =
        new Document("_id", BUNDLE_ID)
            .append("name", BUNDLE_NAME)
            .append("bundle_price", BUNDLE_PRICE)
            .append("base_currency", "USD")
            .append("status", "published")
            .append("created_at", createdAt)
            .append("updated_at", Instant.now());
    coll.replaceOne(Filters.eq("_id", BUNDLE_ID), doc, new ReplaceOptions().upsert(true));
    return 1;
  }

  private int seedBundleMembers() {
    MongoCollection<Document> coll = mongo.getCollection("bundle_members");
    int count = 0;
    for (String skillId : BUNDLE_MEMBER_SKILL_IDS) {
      // Deterministic composite id mirroring the Postgres PRIMARY KEY (bundle_id, skill_id).
      String id = BUNDLE_ID + "::" + skillId;
      Instant createdAt = existingCreatedAt(coll, id);
      Document doc =
          new Document("_id", id)
              .append("bundle_id", BUNDLE_ID)
              .append("skill_id", skillId)
              .append("created_at", createdAt)
              .append("updated_at", Instant.now());
      coll.replaceOne(Filters.eq("_id", id), doc, new ReplaceOptions().upsert(true));
      count++;
    }
    return count;
  }

  // ---------------------------------------------------------------------------------------------
  // regional_prices (BACKEND-DESIGN §3.2, §26.3 PPP tiers)
  // ---------------------------------------------------------------------------------------------

  private record RegionalPriceSeed(
      String targetType, String targetId, String region, long price, String currency) {}

  private int seedRegionalPrices() {
    // PPP-adjusted, not FX-converted: IN/BR prices are the low, "local app-store" price points
    // real storefronts use for a ~$5 US item, not a literal currency conversion of $5.
    List<RegionalPriceSeed> rows =
        List.of(
            // cooking-assistant ($5 US base)
            new RegionalPriceSeed("skill", "cooking-assistant", "US", 500, "USD"),
            new RegionalPriceSeed("skill", "cooking-assistant", "IN", 14_900, "INR"), // ~₹149.00
            new RegionalPriceSeed("skill", "cooking-assistant", "BR", 990, "BRL"), // ~R$9.90
            // home-starter-pack bundle ($12 US base)
            new RegionalPriceSeed("bundle", BUNDLE_ID, "US", BUNDLE_PRICE, "USD"),
            new RegionalPriceSeed("bundle", BUNDLE_ID, "IN", 39_900, "INR"), // ~₹399.00
            new RegionalPriceSeed("bundle", BUNDLE_ID, "BR", 2_990, "BRL") // ~R$29.90
            );

    MongoCollection<Document> coll = mongo.getCollection("regional_prices");
    int count = 0;
    for (RegionalPriceSeed r : rows) {
      // Deterministic composite id mirroring the (target_type, target_id, region) unique index.
      String id = r.targetType() + ":" + r.targetId() + ":" + r.region();
      Instant createdAt = existingCreatedAt(coll, id);
      Document doc =
          new Document("_id", id)
              .append("target_type", r.targetType())
              .append("target_id", r.targetId())
              .append("region", r.region())
              .append("price", r.price())
              .append("currency", r.currency())
              .append("created_at", createdAt)
              .append("updated_at", Instant.now());
      coll.replaceOne(Filters.eq("_id", id), doc, new ReplaceOptions().upsert(true));
      count++;
    }
    return count;
  }

  // ---------------------------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------------------------

  /** Preserves created_at across re-seeds instead of bumping it on every boot. */
  private Instant existingCreatedAt(MongoCollection<Document> coll, Object id) {
    Document existing = coll.find(Filters.eq("_id", id)).first();
    if (existing != null && existing.get("created_at") != null) {
      Object v = existing.get("created_at");
      if (v instanceof Instant instant) {
        return instant;
      }
      if (v instanceof java.util.Date date) {
        return date.toInstant();
      }
    }
    return Instant.now();
  }

  private static byte[] sha256(byte[] input) {
    try {
      return MessageDigest.getInstance("SHA-256").digest(input);
    } catch (NoSuchAlgorithmException e) {
      // SHA-256 is guaranteed present on every JDK provider; this cannot happen.
      throw new IllegalStateException(e);
    }
  }

  private static String toHex(byte[] bytes) {
    StringBuilder sb = new StringBuilder(bytes.length * 2);
    for (byte b : bytes) {
      sb.append(String.format("%02x", b));
    }
    return sb.toString();
  }

  private record SkillSeed(
      String id, String name, String category, boolean free, long basePriceMinor, String compressedPrompt) {}
}
