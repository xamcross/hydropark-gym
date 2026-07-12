package io.hydropark.continuity;

import io.hydropark.catalog.SkillVersion;
import io.hydropark.catalog.SkillVersionRepository;
import io.hydropark.common.Uuid7;
import io.hydropark.licensing.Grant;
import io.hydropark.licensing.GrantRepository;
import io.hydropark.licensing.License;
import io.hydropark.licensing.LicenseRepository;
import io.hydropark.port.Ports.GrantStatus;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * The P1-23.2 final-bundle packager: assembles a {@link ContinuityBundle} for one user from three
 * sources it only <b>reads</b> -
 *
 * <ul>
 *   <li>the user's <b>effective entitlements</b> ({@code active} grants) → the owned skills;
 *   <li>each owned skill's <b>current package</b> ({@link SkillVersion}) → a {@link SkillPackageRef};
 *       and
 *   <li>the user's <b>pre-signed licenses</b> ({@code active} rows minted by the P1-23.1 batch) →
 *       the bundle's license tokens.
 * </ul>
 *
 * <p>The packager <b>never signs</b>. It carries the already-minted tokens verbatim; the signing
 * happened in the issuer zone, gated by the keystone. This class does not depend on any signer or on
 * {@code hydropark.issuer.enabled}, which is exactly the point - packaging and verifying live on the
 * distribution side of the trust boundary, not the signing side.
 */
@Service
public class ContinuityBundlePackager {

  private static final Logger log = LoggerFactory.getLogger(ContinuityBundlePackager.class);

  private final GrantRepository grants;
  private final SkillVersionRepository skillVersions;
  private final LicenseRepository licenses;

  public ContinuityBundlePackager(
      GrantRepository grants,
      SkillVersionRepository skillVersions,
      LicenseRepository licenses) {
    this.grants = grants;
    this.skillVersions = skillVersions;
    this.licenses = licenses;
  }

  /** Assemble the continuity bundle for {@code userId}: owned package refs + pre-signed licenses. */
  public ContinuityBundle assembleForUser(String userId) {
    // (1) Effective entitlements → distinct owned skills, first-seen order preserved.
    Set<String> ownedSkills = new LinkedHashSet<>();
    for (Grant g : grants.findByUserId(userId)) {
      if (GrantStatus.ACTIVE.wire().equals(g.getStatus())) {
        ownedSkills.add(g.getSkillId());
      }
    }

    // (2) Each owned skill's current package → a ref. A skill with no current package can't be
    // installed offline, so it is omitted (and logged) rather than bundled as a dangling ref.
    List<SkillPackageRef> packageRefs = new ArrayList<>();
    List<String> packagedSkillIds = new ArrayList<>();
    for (String skillId : ownedSkills) {
      Optional<SkillVersion> current = skillVersions.findBySkillIdAndCurrentTrue(skillId);
      if (current.isEmpty()) {
        log.warn("continuity bundle for {} omits skill {}: no current package version", userId, skillId);
        continue;
      }
      SkillVersion v = current.get();
      packageRefs.add(
          new SkillPackageRef(
              skillId, v.getVersion(), v.getPackageUri(), v.getPackageSha256(), v.getSigningKeyId()));
      packagedSkillIds.add(skillId);
    }

    // (3) The user's pre-signed active licenses → tokens carried verbatim.
    List<String> licenseTokens = new ArrayList<>();
    List<String> licenseIds = new ArrayList<>();
    for (License l : licenses.findByUserIdAndStatus(userId, "active")) {
      licenseTokens.add(l.getToken());
      licenseIds.add(l.getId());
    }

    ContinuityBundleManifest manifest =
        new ContinuityBundleManifest(
            Uuid7.prefixed("cbundle"),
            userId,
            Instant.now(),
            packageRefs.size(),
            licenseTokens.size(),
            List.copyOf(packagedSkillIds),
            List.copyOf(licenseIds));

    return new ContinuityBundle(manifest, List.copyOf(packageRefs), List.copyOf(licenseTokens));
  }
}
