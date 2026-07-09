package io.hydropark.migration.changesets;

import com.mongodb.client.model.Collation;
import com.mongodb.client.model.CollationStrength;
import com.mongodb.client.model.Filters;
import com.mongodb.client.model.IndexOptions;
import com.mongodb.client.model.Indexes;
import io.hydropark.migration.Migration;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.stereotype.Component;

/**
 * Indexes for {@code users} and {@code oauth_identities} (BACKEND-DESIGN §3.1, AGENT-CONTRACT
 * "auth" package).
 *
 * <p>{@code users.email} is the one that carries correctness: email is optional (a device-only
 * user may have none), so the uniqueness constraint must not collide on absence, and comparisons
 * must be case-insensitive the way Postgres {@code citext} would be (§11.1: "citext unique email
 * -> case-insensitive collation unique index").
 */
@Component
public class V001CreateUsersAndOauthIndexes implements Migration {

  @Override
  public String id() {
    return "V001__create_users_and_oauth_indexes";
  }

  @Override
  public String description() {
    return "unique case-insensitive partial index on users.email; unique (provider, provider_sub) "
        + "on oauth_identities";
  }

  @Override
  public void apply(MongoTemplate mongo) {
    // users.email: unique, case-insensitive (collation strength SECONDARY ~= citext), and
    // partial so that accounts with no email never collide. We filter on {$type: "string"}
    // rather than {$exists: true}: the latter would still index (and collide on) documents
    // where the application stored `email: null` instead of omitting the field. Service code
    // must OMIT the field entirely for email-less accounts - never set it to null - but this
    // index is defensive against that mistake either way.
    mongo.getCollection("users")
        .createIndex(
            Indexes.ascending("email"),
            new IndexOptions()
                .name("users_email_unique_ci")
                .unique(true)
                .collation(
                    Collation.builder().locale("en").collationStrength(CollationStrength.SECONDARY).build())
                .partialFilterExpression(Filters.type("email", "string")));

    // oauth_identities: unique (provider, provider_sub) - the provider's stable subject id can
    // only ever be linked to one of our users.
    mongo.getCollection("oauth_identities")
        .createIndex(
            Indexes.ascending("provider", "provider_sub"),
            new IndexOptions().name("oauth_identities_provider_sub_unique").unique(true));

    // Reverse lookup: "which identities does this user have" (a user may link both Google and
    // Apple). Not unique - not in the "get this exactly right" list, just a normal query index.
    mongo.getCollection("oauth_identities")
        .createIndex(Indexes.ascending("user_id"), new IndexOptions().name("oauth_identities_user_id_idx"));
  }
}
