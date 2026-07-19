package io.hydropark.licensing;

import java.util.List;
import java.util.Optional;
import org.springframework.data.mongodb.repository.MongoRepository;

/** Spring Data access for {@code licenses}. */
public interface LicenseRepository extends MongoRepository<License, String> {

  /** The one live license per {@code (skill, device)} - the idempotent-reissue lookup. */
  Optional<License> findByUserIdAndSkillIdAndDeviceIdAndStatus(
      String userId, String skillId, String deviceId, String status);

  /**
   * All licenses for a user in a given status - the P1-23.2 continuity packager collects a user's
   * {@code active} pre-signed tokens to bundle. The stored {@code token} is the audit copy the
   * bundle carries; it is re-verified against the trusted key set on the client, never re-signed.
   */
  List<License> findByUserIdAndStatus(String userId, String status);

  /** Stranding exposure for a key nearing roll-off (§6.3 coverage gate). */
  long countByStatusAndSigningKeyId(String status, String signingKeyId);

  /** Re-issue candidates: still-live licenses signed under a given key. */
  List<License> findByStatusAndSigningKeyId(String status, String signingKeyId);

  /** All live licenses - the reissuer filters these by kid nearing roll-off. */
  List<License> findByStatus(String status);
}
