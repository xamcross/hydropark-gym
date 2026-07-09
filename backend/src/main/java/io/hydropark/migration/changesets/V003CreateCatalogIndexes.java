package io.hydropark.migration.changesets;

import com.mongodb.client.model.Filters;
import com.mongodb.client.model.IndexOptions;
import com.mongodb.client.model.Indexes;
import io.hydropark.migration.Migration;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.stereotype.Component;

/**
 * Indexes for the catalog collections (BACKEND-DESIGN §3.2): {@code skills}, {@code
 * skill_versions}, {@code bundles}, {@code bundle_members}, {@code regional_prices}.
 *
 * <p>The one that carries correctness here is {@code skill_versions}: semver is not sortable, so
 * "what is the current version of this skill" cannot be derived by sorting {@code version} -
 * {@code is_current} is the only source of truth, and the unique partial index below is what
 * guarantees at most one row can claim that per skill (mirrors the Postgres {@code CREATE UNIQUE
 * INDEX ON skill_versions (skill_id) WHERE is_current}).
 */
@Component
public class V003CreateCatalogIndexes implements Migration {

  @Override
  public String id() {
    return "V003__create_catalog_indexes";
  }

  @Override
  public String description() {
    return "skill_versions unique (skill_id, version) + unique partial current version; "
        + "bundle_members composite unique; regional_prices unique (target_type, target_id, region)";
  }

  @Override
  public void apply(MongoTemplate mongo) {
    // skills._id is the human slug (AGENT-CONTRACT: skills.id / bundles.id are slugs, not
    // UUIDv7s), so it is already unique via _id. Add a listing index for the public, cacheable
    // catalog endpoint (§4.2), which filters by status and browses by category.
    mongo.getCollection("skills")
        .createIndex(
            Indexes.ascending("status", "category"), new IndexOptions().name("skills_status_category_idx"));

    // skill_versions: one row per (skill_id, version)...
    mongo.getCollection("skill_versions")
        .createIndex(
            Indexes.ascending("skill_id", "version"),
            new IndexOptions().name("skill_versions_skill_id_version_unique").unique(true));

    // ...and AT MOST ONE row per skill_id may have is_current: true. This is a unique index on
    // skill_id alone, scoped by a partial filter - not a compound index - because uniqueness
    // must hold across ALL versions of a skill, not per (skill_id, is_current) pair.
    mongo.getCollection("skill_versions")
        .createIndex(
            Indexes.ascending("skill_id"),
            new IndexOptions()
                .name("skill_versions_current_unique")
                .unique(true)
                .partialFilterExpression(Filters.eq("is_current", true)));

    // bundles._id is also a slug (e.g. "home-starter-pack"); no extra index needed beyond a
    // light status filter for the catalog listing, mirroring skills above.
    mongo.getCollection("bundles")
        .createIndex(Indexes.ascending("status"), new IndexOptions().name("bundles_status_idx"));

    // bundle_members: Postgres PRIMARY KEY (bundle_id, skill_id). Mongo _id here is an
    // app-generated id (not the composite), so the composite uniqueness needs its own index.
    mongo.getCollection("bundle_members")
        .createIndex(
            Indexes.ascending("bundle_id", "skill_id"),
            new IndexOptions().name("bundle_members_bundle_skill_unique").unique(true));
    // Reverse lookup: "which bundles is this skill a member of" (used e.g. to explain why a
    // skill already appears owned via a bundle grant).
    mongo.getCollection("bundle_members")
        .createIndex(Indexes.ascending("skill_id"), new IndexOptions().name("bundle_members_skill_id_idx"));

    // regional_prices: polymorphic (target_type, target_id) with NO FK (§3.2 integrity note) -
    // the service layer validates existence at write time. The unique index is still the
    // correctness property: no two rows may claim the same (target_type, target_id, region).
    mongo.getCollection("regional_prices")
        .createIndex(
            Indexes.ascending("target_type", "target_id", "region"),
            new IndexOptions().name("regional_prices_target_region_unique").unique(true));
  }
}
