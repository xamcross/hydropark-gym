package io.hydropark.licensing;

import io.hydropark.common.CursorPage;
import java.util.List;
import org.springframework.data.domain.Sort;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.stereotype.Service;

/**
 * Read side of {@code GET /v1/licenses}. Cursor-paginated over {@code _id} (a UUIDv7, so id order is
 * creation order); returns metadata only, never the token.
 */
@Service
public class LicenseQueryService {

  private final MongoTemplate mongo;

  public LicenseQueryService(MongoTemplate mongo) {
    this.mongo = mongo;
  }

  public CursorPage<LicenseMetadata> listLicenses(
      String userId, String deviceId, String cursor, Integer limit) {
    int lim = CursorPage.clampLimit(limit);
    String after = CursorPage.decode(cursor);

    Criteria c = Criteria.where("user_id").is(userId);
    if (deviceId != null && !deviceId.isBlank()) {
      c = c.and("device_id").is(deviceId);
    }
    if (after != null) {
      c = c.and("_id").lt(after);
    }

    Query q = Query.query(c).with(Sort.by(Sort.Direction.DESC, "_id")).limit(lim + 1);
    List<License> rows = mongo.find(q, License.class);

    CursorPage<License> page = CursorPage.from(rows, lim, License::getId);
    List<LicenseMetadata> items = page.items().stream().map(LicenseMetadata::of).toList();
    return new CursorPage<>(items, page.nextCursor());
  }
}
