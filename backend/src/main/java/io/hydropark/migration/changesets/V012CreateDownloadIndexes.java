package io.hydropark.migration.changesets;

import com.mongodb.client.model.IndexOptions;
import com.mongodb.client.model.Indexes;
import io.hydropark.migration.Migration;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.stereotype.Component;

/**
 * Indexes for the content-delivery collections (P1-19): {@code download_records} (watermark
 * buyer-tokens) and {@code cdn_egress} (per-download egress samples).
 *
 * <p>Two access paths carry weight here:
 *
 * <ul>
 *   <li>{@code download_records (user_id, issued_at desc)} - the GDPR erasure scrub (P1-12.6) deletes
 *       a subject's rows by {@code user_id}, and "my downloads" lists them newest-first.
 *   <li>{@code download_records.watermark_token} - leak tracing does the reverse lookup, recovering
 *       the buyer behind a watermark lifted from a leaked package.
 * </ul>
 *
 * <p>{@code cdn_egress (served_at)} serves the gross-margin gate's windowed byte aggregation (P1-19.4).
 * No unique constraints: both collections are append-only event logs, and the watermark is
 * deterministic per {@code (user, skill, version)}, so a re-download legitimately repeats a token.
 */
@Component
public class V012CreateDownloadIndexes implements Migration {

  @Override
  public String id() {
    return "V012__create_download_indexes";
  }

  @Override
  public String description() {
    return "download_records (user_id, issued_at) + watermark_token + (skill_id, version); "
        + "cdn_egress served_at";
  }

  @Override
  public void apply(MongoTemplate mongo) {
    // download_records: GDPR scrub by user_id + newest-first "my downloads" listing.
    mongo.getCollection("download_records")
        .createIndex(
            Indexes.compoundIndex(Indexes.ascending("user_id"), Indexes.descending("issued_at")),
            new IndexOptions().name("download_records_user_id_issued_at_idx"));

    // download_records: reverse lookup from a leaked watermark back to the buyer.
    mongo.getCollection("download_records")
        .createIndex(
            Indexes.ascending("watermark_token"),
            new IndexOptions().name("download_records_watermark_token_idx"));

    // download_records: "who pulled this exact version" (leak-blast-radius / analytics).
    mongo.getCollection("download_records")
        .createIndex(
            Indexes.ascending("skill_id", "version"),
            new IndexOptions().name("download_records_skill_version_idx"));

    // cdn_egress: windowed byte aggregation for the gross-margin gate.
    mongo.getCollection("cdn_egress")
        .createIndex(
            Indexes.ascending("served_at"), new IndexOptions().name("cdn_egress_served_at_idx"));
  }
}
