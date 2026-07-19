package io.hydropark.download;

import io.hydropark.catalog.Skill;
import io.hydropark.catalog.SkillVersion;
import io.hydropark.common.ApiException;
import io.hydropark.common.Uuid7;
import io.hydropark.port.Ports;
import java.time.Instant;
import java.util.regex.Pattern;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.stereotype.Service;

/**
 * Content-delivery orchestration for P1-19.2 (paid skill packages) and P1-19.3 (the free base model).
 *
 * <p>Ownership is checked the same way the rest of the system checks it: a skill is deliverable when
 * it is free, or when the caller holds an active grant ({@link Ports.GrantPort#hasActiveGrant}) - never
 * a stored entitlement row (BACKEND-DESIGN §4.4). Catalog metadata (the {@code is_free} flag and the
 * version's object key + size) is read straight from the shared collections via {@link MongoTemplate},
 * mirroring how {@link io.hydropark.catalog.CatalogService} reads its own read model, so this package
 * pulls ownership through a port and never invokes another domain's beans.
 */
@Service
public class DownloadService {

  /** Shared scope keeps the free model URL identical across users, so the CDN can cache it (P1-19.3). */
  static final String PUBLIC_SCOPE = "public";

  private static final String TYPE_SKILL = "skill";
  private static final String TYPE_MODEL = "model";

  /** modelId lands in an object-store key; keep it to a safe, traversal-proof charset. */
  private static final Pattern SAFE_MODEL_ID = Pattern.compile("[A-Za-z0-9._-]+");

  private final MongoTemplate mongo;
  private final Ports.GrantPort grants;
  private final BlobStore blobStore;
  private final BlobStoreProperties props;
  private final DownloadRecordRepository downloadRecords;
  private final EgressMeter egress;

  public DownloadService(
      MongoTemplate mongo,
      Ports.GrantPort grants,
      BlobStore blobStore,
      BlobStoreProperties props,
      DownloadRecordRepository downloadRecords,
      EgressMeter egress) {
    this.mongo = mongo;
    this.grants = grants;
    this.blobStore = blobStore;
    this.props = props;
    this.downloadRecords = downloadRecords;
    this.egress = egress;
  }

  /**
   * Issues a paid-skill package download. 404 for an unknown skill/version, 403 when the caller owns
   * neither a free skill nor an active grant. On success: a short-TTL user-scoped URL, a persisted
   * watermark buyer-token, and an egress sample.
   */
  public SkillDownloadResponse issueSkillDownload(String userId, String skillId, String version) {
    Skill skill = mongo.findById(skillId, Skill.class);
    if (skill == null) {
      throw ApiException.notFound("skill");
    }
    // Entitlement gate BEFORE revealing whether the version exists: a non-owner gets a flat 403 and
    // learns nothing about the catalog's version history.
    if (!skill.isFree() && !grants.hasActiveGrant(userId, skillId)) {
      throw ApiException.notEntitled(skillId);
    }

    SkillVersion sv =
        mongo.findOne(
            Query.query(Criteria.where("skill_id").is(skillId).and("version").is(version)),
            SkillVersion.class);
    if (sv == null || sv.getPackageUri() == null || sv.getPackageUri().isBlank()) {
      throw ApiException.notFound("skill version");
    }

    String objectKey = sv.getPackageUri();
    // User-scoped: the URL is bound to this buyer and non-transferable (SF8).
    SignedUrl signed = blobStore.signedUrl(objectKey, userId, props.getSkillUrlTtl());

    String watermark =
        Hmac.sha256Base64Url(
            props.getHmacSecret(), "watermark|" + userId + "|" + skillId + "|" + version);

    Instant now = Instant.now();
    downloadRecords.save(
        DownloadRecord.create(Uuid7.generate(), userId, skillId, version, watermark, now));
    egress.record(userId, TYPE_SKILL, objectKey, sv.getPackageBytes());

    return new SkillDownloadResponse(signed.url(), signed.expiresAt(), watermark);
  }

  /**
   * Issues the free base-model download (P1-19.3): no entitlement, no watermark, a shared-scope
   * long-TTL URL the CDN can cache. Still metered so model egress feeds the margin gate.
   */
  public ModelDownloadResponse issueModelDownload(String modelId) {
    if (modelId == null || !SAFE_MODEL_ID.matcher(modelId).matches()) {
      throw ApiException.validation("invalid model id");
    }
    String objectKey = "models/" + modelId + ".gguf";
    SignedUrl signed = blobStore.signedUrl(objectKey, PUBLIC_SCOPE, props.getModelUrlTtl());
    egress.record(null, TYPE_MODEL, objectKey, props.getModelBytesEstimate());
    return new ModelDownloadResponse(signed.url(), signed.expiresAt());
  }
}
