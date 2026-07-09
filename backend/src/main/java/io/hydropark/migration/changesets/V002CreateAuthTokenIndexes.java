package io.hydropark.migration.changesets;

import com.mongodb.client.model.IndexOptions;
import com.mongodb.client.model.Indexes;
import io.hydropark.migration.Migration;
import java.util.concurrent.TimeUnit;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.stereotype.Component;

/**
 * Indexes for the short-lived auth token collections (BACKEND-DESIGN §3.6): {@code
 * refresh_tokens}, {@code email_verification_tokens}, {@code password_reset_tokens}, {@code
 * step_up_challenges}.
 *
 * <p>{@code email_verification_tokens} and {@code password_reset_tokens} use {@code token_hash}
 * as their Postgres primary key; by AGENT-CONTRACT convention the Mongo {@code _id} carries that
 * value directly, so uniqueness there is already given by {@code _id} and needs no secondary
 * index. {@code step_up_challenges} follows the same shape (§8, the passwordless step-up token
 * backing {@code StepUpPort}). All four collections get a TTL index on {@code expires_at} so
 * Mongo reaps expired rows itself instead of every read filtering on {@code expires_at > now()}.
 *
 * <p>TTL indexes use {@code expireAfter(0, SECONDS)}: the stored {@code expires_at} value already
 * IS the expiry instant (computed by the application from the relevant TTL config, e.g. {@code
 * hydropark.auth.step-up-token-ttl-seconds}), so the index just deletes at that instant rather
 * than adding a further offset.
 */
@Component
public class V002CreateAuthTokenIndexes implements Migration {

  @Override
  public String id() {
    return "V002__create_auth_token_indexes";
  }

  @Override
  public String description() {
    return "unique refresh_tokens.token_hash + TTL; TTL on email_verification_tokens, "
        + "password_reset_tokens, step_up_challenges expires_at";
  }

  @Override
  public void apply(MongoTemplate mongo) {
    // refresh_tokens: unique token_hash (we only ever store the hash, never the raw token).
    mongo.getCollection("refresh_tokens")
        .createIndex(
            Indexes.ascending("token_hash"),
            new IndexOptions().name("refresh_tokens_token_hash_unique").unique(true));

    // TTL: once a refresh token's window has passed it is useless even if never rotated.
    mongo.getCollection("refresh_tokens")
        .createIndex(
            Indexes.ascending("expires_at"),
            new IndexOptions().name("refresh_tokens_expires_at_ttl").expireAfter(0L, TimeUnit.SECONDS));

    // Reuse-detection revokes a whole family_id at once (§3.6) - index the lookup path.
    mongo.getCollection("refresh_tokens")
        .createIndex(Indexes.ascending("family_id"), new IndexOptions().name("refresh_tokens_family_id_idx"));

    // email_verification_tokens: _id IS token_hash (the Postgres PK). Only the TTL is needed.
    mongo.getCollection("email_verification_tokens")
        .createIndex(
            Indexes.ascending("expires_at"),
            new IndexOptions()
                .name("email_verification_tokens_expires_at_ttl")
                .expireAfter(0L, TimeUnit.SECONDS));
    mongo.getCollection("email_verification_tokens")
        .createIndex(
            Indexes.ascending("user_id"),
            new IndexOptions().name("email_verification_tokens_user_id_idx"));

    // password_reset_tokens: same shape.
    mongo.getCollection("password_reset_tokens")
        .createIndex(
            Indexes.ascending("expires_at"),
            new IndexOptions()
                .name("password_reset_tokens_expires_at_ttl")
                .expireAfter(0L, TimeUnit.SECONDS));
    mongo.getCollection("password_reset_tokens")
        .createIndex(
            Indexes.ascending("user_id"), new IndexOptions().name("password_reset_tokens_user_id_idx"));

    // step_up_challenges: not in the BACKEND-DESIGN §3 SQL listing (it backs StepUpPort, added
    // post-doc per §8's passwordless step-up flow), but follows the identical short-TTL-token
    // shape as the two collections above.
    mongo.getCollection("step_up_challenges")
        .createIndex(
            Indexes.ascending("expires_at"),
            new IndexOptions().name("step_up_challenges_expires_at_ttl").expireAfter(0L, TimeUnit.SECONDS));
    mongo.getCollection("step_up_challenges")
        .createIndex(Indexes.ascending("user_id"), new IndexOptions().name("step_up_challenges_user_id_idx"));
  }
}
