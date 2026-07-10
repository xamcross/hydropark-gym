package io.hydropark.migration.changesets;

import com.mongodb.client.MongoCollection;
import com.mongodb.client.model.Filters;
import com.mongodb.client.model.ReplaceOptions;
import com.mongodb.client.model.Updates;
import io.hydropark.migration.Migration;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;
import org.bson.Document;
import org.bson.conversions.Bson;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.stereotype.Component;

/**
 * Renames the free timer skill's slug from {@code kitchen-timer-units} to {@code kitchen-timer} in
 * databases already seeded under the old slug. The owner settled the id conflict on
 * {@code kitchen-timer} (matching {@code landing-gym/}); {@link io.hydropark.seed.CatalogSeeder} now
 * seeds the new slug, and this changeset re-slugs any database that ran the old seed.
 *
 * <p><b>Why this is not a one-line {@code $set}.</b> For {@code skills} the slug <em>is</em> the
 * {@code _id} (AGENT-CONTRACT: {@code skills._id}/{@code bundles._id} are human slugs, not UUIDv7s),
 * and MongoDB cannot update {@code _id}. A slug rename is therefore: read the old document, insert it
 * under the new {@code _id}, delete the old, and then chase every reference. Some of those references
 * are themselves keyed on the slug and need the same copy-delete treatment (see below).
 *
 * <p><b>References chased (whole {@code hydropark} database).</b> {@code regional_prices} is
 * polymorphic ({@code target_type} + {@code target_id}) with <em>no</em> foreign keys (§3.2), so
 * nothing in the database will complain about a missed reference - this list is transcribed by hand
 * from the schema and the seeder, not discovered:
 *
 * <ul>
 *   <li>{@code skills} - re-key the document {@code kitchen-timer-units} -&gt; {@code kitchen-timer}.
 *   <li>{@code skill_versions} - the seeder mints {@code _id = "<skill_id>@<version>"}, so the
 *       {@code _id} <b>embeds the slug</b> and is re-keyed too, not just the {@code skill_id} field.
 *       A stale {@code kitchen-timer-units@1.0.0} left behind would still carry the old slug and
 *       would violate nothing, so it would survive review silently.
 *   <li>{@code bundle_members} - seeder {@code _id = "<bundle_id>::<skill_id>"} also embeds the
 *       slug; re-keyed. (The free timer belongs to no bundle today, so this matches zero rows - but
 *       a future membership would rot without it.)
 *   <li>{@code regional_prices} - seeder {@code _id = "<target_type>:<target_id>:<region>"} embeds
 *       the slug; re-keyed, and the {@code target_id} field renamed, only for {@code
 *       target_type='skill'} rows.
 *   <li>{@code grants}, {@code licenses}, {@code license_audit} - these carry runtime UUIDv7
 *       {@code _id}s (this seeder never writes them), so only the {@code skill_id} <em>field</em> is
 *       renamed; the {@code _id} stays.
 * </ul>
 *
 * <p><b>What is deliberately NOT rewritten.</b> {@code skill_versions.package_uri} is a pointer to a
 * stored object ({@code skills/<slug>/<version>/package.hpskill}) that this migration cannot move;
 * {@code package_sha256} and {@code signature} are facts about the <em>package bytes</em>, which a
 * slug rename does not change. Rewriting the pointer without relocating the object would break
 * downloads, so all three are left as-is. A database migrated by this changeset therefore diverges
 * from one freshly seeded under the new slug only in these pointer/derived fields, never in identity.
 *
 * <p><b>The {@code licenses.skill_id} rename does not re-sign anything.</b> A license already minted
 * for {@code kitchen-timer-units} was signed as a compact Ed25519 JWS over a payload that contains
 * that exact string (AGENT-CONTRACT security property 7: signed over exact bytes, verified over the
 * received bytes). Renaming the row's {@code skill_id} field mutates the stored copy but does
 * <em>not</em> re-sign the token, so the token's payload still says {@code kitchen-timer-units} and
 * the client verifying it will see a slug that no longer exists in the catalog. The correct remedy is
 * <b>re-issue</b> (a fresh sign under the new slug), not a field edit. In practice the timer skill is
 * <em>free</em>, so no license should ever have been minted for it and this update should match zero
 * rows - but we rename the field rather than silently pretend the case is impossible.
 *
 * <p><b>Crash safety without a transaction.</b> These writes span seven collections, so a transaction
 * is the obvious reach - but this changeset deliberately does <em>not</em> open one, for three
 * reasons. (1) The {@link Migration} contract already mandates idempotency, because {@code apply()}
 * can be re-run after a crash between the write and the {@code schema_migrations} ledger insert (that
 * insert happens in {@code MigrationRunner}, outside {@code apply()}). A transaction buys atomicity
 * but not run-once, so idempotency is required either way and, once present, makes the transaction
 * non-load-bearing for correctness. (2) The migration runner already holds an exclusive lock, so
 * concurrent migrators are not the hazard - a crash mid-rename is - and a transaction is not the only
 * tool against that. (3) Requiring transaction support would couple the one-shot migrator job to a
 * replica-set topology the other index changesets (V001-V010) never assume.
 *
 * <p>Instead the writes are <b>ordered so the OLD {@code skills} document is the completion
 * sentinel</b>: the new-keyed {@code skills} doc is inserted first, every reference is chased next,
 * and the old {@code skills} doc is deleted <em>last</em>. The idempotency guard is exactly "does the
 * old {@code skills} slug still exist" - which stays true until the very last write - so a crash at
 * any point leaves the guard tripped and re-running redoes each step idempotently (every reference
 * write is either an upsert on the new key or a {@code skill_id=OLD} match that no longer matches
 * once done). During the window where both {@code skills} docs coexist, no unique index is violated:
 * {@code skills} is unique only on {@code _id} (V003), and the re-keyed {@code skill_versions} row
 * carries the <em>new</em> {@code skill_id} while the stale one still carries the old, so the unique
 * {@code (skill_id, version)} and unique-partial {@code (skill_id) WHERE is_current} indexes see two
 * distinct slugs, never a duplicate.
 *
 * <p>Running twice, or against a database seeded fresh with {@code kitchen-timer}, is a clean no-op:
 * the guard finds no old {@code skills} document and returns immediately.
 */
@Component
public class V011RenameKitchenTimerSku implements Migration {

  private static final Logger log = LoggerFactory.getLogger(V011RenameKitchenTimerSku.class);

  private static final String OLD_ID = "kitchen-timer-units";
  private static final String NEW_ID = "kitchen-timer";

  private static final ReplaceOptions UPSERT = new ReplaceOptions().upsert(true);

  @Override
  public String id() {
    return "V011__rename_kitchen_timer_sku";
  }

  @Override
  public String description() {
    return "rename free timer skill slug kitchen-timer-units -> kitchen-timer: re-key skills, "
        + "re-key composite _id + field on skill_versions/bundle_members/regional_prices, and "
        + "rename the skill_id field on grants/licenses/license_audit";
  }

  @Override
  public void apply(MongoTemplate mongo) {
    MongoCollection<Document> skills = mongo.getCollection("skills");

    // Idempotency guard / completion sentinel. skills._id is the slug (natural key); the OLD doc is
    // deleted LAST, so its presence means "not yet fully renamed". Absent -> already done, or the
    // database was seeded fresh under the new slug: either way a clean no-op.
    Document oldSkill = skills.find(Filters.eq("_id", OLD_ID)).first();
    if (oldSkill == null) {
      log.info("V011: skills/{} absent; nothing to rename (idempotent no-op)", OLD_ID);
      return;
    }

    // 1. Re-key the skills document. Insert the NEW-keyed copy first; the OLD copy is removed only
    //    at the very end (step 3), so every intermediate state keeps the sentinel tripped.
    Document newSkill = new Document(oldSkill);
    newSkill.put("_id", NEW_ID);
    skills.replaceOne(Filters.eq("_id", NEW_ID), newSkill, UPSERT);

    // 2. Chase every reference.

    // skill_versions._id = "<skill_id>@<version>" -> embeds the slug; re-key + rename field.
    rekeyEmbeddedSlug(
        mongo.getCollection("skill_versions"),
        Filters.eq("skill_id", OLD_ID),
        "skill_id",
        d -> OLD_ID + "@" + d.getString("version"),
        d -> NEW_ID + "@" + d.getString("version"));

    // bundle_members._id = "<bundle_id>::<skill_id>" -> embeds the slug; re-key + rename field.
    rekeyEmbeddedSlug(
        mongo.getCollection("bundle_members"),
        Filters.eq("skill_id", OLD_ID),
        "skill_id",
        d -> d.getString("bundle_id") + "::" + OLD_ID,
        d -> d.getString("bundle_id") + "::" + NEW_ID);

    // regional_prices._id = "<target_type>:<target_id>:<region>"; the slug is target_id, and only
    // rows targeting a skill are ours (the polymorphic type must be pinned or we would rename a
    // bundle that happened to share the string).
    rekeyEmbeddedSlug(
        mongo.getCollection("regional_prices"),
        Filters.and(Filters.eq("target_type", "skill"), Filters.eq("target_id", OLD_ID)),
        "target_id",
        d -> "skill:" + OLD_ID + ":" + d.getString("region"),
        d -> "skill:" + NEW_ID + ":" + d.getString("region"));

    // grants / licenses / license_audit carry UUIDv7 _ids (not composite): rename the field only.
    renameSkillIdField(mongo.getCollection("grants"));
    renameSkillIdField(mongo.getCollection("licenses"));
    renameSkillIdField(mongo.getCollection("license_audit"));

    // 3. Delete the OLD skills document LAST - the sentinel that marks the rename complete.
    skills.deleteOne(Filters.eq("_id", OLD_ID));

    log.info("V011: renamed skill slug {} -> {}", OLD_ID, NEW_ID);
  }

  /**
   * Re-key every document matched by {@code filter} whose {@code _id} is the composite the seeder
   * would have minted from the old slug: insert a NEW-keyed copy (with {@code _id} and {@code
   * slugField} both updated) then delete the stale row. A document whose {@code _id} is <em>not</em>
   * that composite (a runtime UUIDv7) has only its {@code slugField} set in place. Both branches are
   * idempotent, and the copy-then-delete order keeps the stale key present until the new key is
   * durable so a crashed run resumes cleanly.
   */
  private void rekeyEmbeddedSlug(
      MongoCollection<Document> coll,
      Bson filter,
      String slugField,
      Function<Document, String> oldCompositeId,
      Function<Document, String> newCompositeId) {
    // Snapshot first: we mutate _id (delete + insert) as we iterate, which a live cursor forbids.
    List<Document> matches = new ArrayList<>();
    coll.find(filter).into(matches);
    for (Document d : matches) {
      Object currentId = d.get("_id");
      if (oldCompositeId.apply(d).equals(currentId)) {
        String newId = newCompositeId.apply(d);
        Document copy = new Document(d);
        copy.put("_id", newId);
        copy.put(slugField, NEW_ID);
        coll.replaceOne(Filters.eq("_id", newId), copy, UPSERT); // durable NEW key first
        coll.deleteOne(Filters.eq("_id", currentId)); // then drop the stale key
      } else {
        coll.updateOne(Filters.eq("_id", currentId), Updates.set(slugField, NEW_ID));
      }
    }
  }

  /** Rename {@code skill_id} in place for a UUIDv7-keyed collection. Idempotent by construction. */
  private void renameSkillIdField(MongoCollection<Document> coll) {
    coll.updateMany(Filters.eq("skill_id", OLD_ID), Updates.set("skill_id", NEW_ID));
  }
}
