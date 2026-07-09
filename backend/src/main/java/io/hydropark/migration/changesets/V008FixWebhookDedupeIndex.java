package io.hydropark.migration.changesets;

import com.mongodb.client.model.IndexOptions;
import com.mongodb.client.model.Indexes;
import io.hydropark.migration.Migration;
import org.bson.Document;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.stereotype.Component;

/**
 * Makes the webhook dedupe index <b>partial</b>, so it constrains only rows that actually carry a
 * {@code provider_event_id}.
 *
 * <p>V004 created it as a plain unique index. That is wrong, and the failure is severe rather than
 * cosmetic. The public {@code POST /v1/webhooks/mor} handler is deliberately receive-only: it
 * captures raw bytes and enqueues, <em>without parsing</em>, because the MoR HMAC must be verified
 * over untouched bytes by the settlement worker (§3.5). It therefore cannot know
 * {@code provider_event_id} at insert time, and omits the field. MongoDB indexes a missing field as
 * {@code null} and a plain unique index rejects a second {@code null} - so once any single row sat
 * unclaimed (a dead-lettered event whose signature never verified, say), <b>every subsequent webhook
 * was rejected at the edge with a duplicate-key 409</b> and the payment pipeline silently stopped
 * settling.
 *
 * <p>The partial filter restores the intended semantics: many unparsed rows may coexist, while the
 * worker's claim - which is the write that first sets {@code provider_event_id} - still trips a
 * duplicate-key error on redelivery and short-circuits before any grant is created. Dedupe still
 * happens exactly where the design says it does, at the claim, not at capture.
 *
 * <p>Filtering on {@code $type: "string"} rather than {@code $exists: true} additionally covers a
 * row that stored an explicit {@code null}.
 *
 * <p>V004 is left untouched: a released changeset is never edited, because the ledger records that
 * it ran and re-editing it would leave deployed databases silently disagreeing with the source tree.
 */
@Component
public class V008FixWebhookDedupeIndex implements Migration {

  private static final String COLLECTION = "webhook_events";
  private static final String OLD_INDEX = "webhook_events_provider_event_id_unique";
  private static final String NEW_INDEX = "webhook_events_provider_event_id_unique_partial";

  @Override
  public String id() {
    return "V008__fix_webhook_dedupe_index_partial";
  }

  @Override
  public String description() {
    return "webhook_events.provider_event_id unique index becomes partial ($type:string) so the "
        + "receive-only edge can capture many not-yet-parsed rows";
  }

  @Override
  public void apply(MongoTemplate mongo) {
    var collection = mongo.getCollection(COLLECTION);

    for (Document existing : collection.listIndexes()) {
      if (OLD_INDEX.equals(existing.getString("name"))) {
        collection.dropIndex(OLD_INDEX);
        break;
      }
    }

    collection.createIndex(
        Indexes.ascending("provider_event_id"),
        new IndexOptions()
            .name(NEW_INDEX)
            .unique(true)
            .partialFilterExpression(
                new Document("provider_event_id", new Document("$type", "string"))));
  }
}
