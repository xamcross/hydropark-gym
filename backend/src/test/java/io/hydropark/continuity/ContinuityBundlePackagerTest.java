package io.hydropark.continuity;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.when;

import io.hydropark.catalog.SkillVersion;
import io.hydropark.catalog.SkillVersionRepository;
import io.hydropark.licensing.Grant;
import io.hydropark.licensing.GrantRepository;
import io.hydropark.licensing.License;
import io.hydropark.licensing.LicenseRepository;
import io.hydropark.port.Ports.GrantSource;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

/**
 * The P1-23.2 packager assembles the expected bundle from a user's effective entitlements, the current
 * package for each owned skill, and the user's pre-signed licenses - deduping skills held under more
 * than one active grant and omitting a skill that has no current package. Pure Mockito; no Docker.
 */
@ExtendWith(MockitoExtension.class)
class ContinuityBundlePackagerTest {

  @Mock GrantRepository grants;
  @Mock SkillVersionRepository skillVersions;
  @Mock LicenseRepository licenses;

  @Test
  void assemblesOwnedPackageRefsAndPreSignedLicenses() {
    // user1 owns skillA (twice - standalone + bundle), skillB, and skillD.
    when(grants.findByUserId("user1"))
        .thenReturn(
            List.of(
                active("g1", "user1", "skillA", GrantSource.STANDALONE),
                active("g2", "user1", "skillA", GrantSource.BUNDLE),
                active("g3", "user1", "skillB", GrantSource.STANDALONE),
                active("g4", "user1", "skillD", GrantSource.STANDALONE)));

    when(skillVersions.findBySkillIdAndCurrentTrue("skillA"))
        .thenReturn(Optional.of(version("skillA", "1.2.0", "blob://a", "sha-a", "hp-pkg-2026a")));
    when(skillVersions.findBySkillIdAndCurrentTrue("skillB"))
        .thenReturn(Optional.of(version("skillB", "3.0.0", "blob://b", "sha-b", "hp-pkg-2026a")));
    // skillD is owned but has no current package -> omitted from the bundle.
    when(skillVersions.findBySkillIdAndCurrentTrue("skillD")).thenReturn(Optional.empty());

    when(licenses.findByUserIdAndStatus("user1", "active"))
        .thenReturn(
            List.of(
                license("licA", "user1", "skillA", "dev1", "token-A"),
                license("licB", "user1", "skillB", "dev1", "token-B")));

    ContinuityBundle bundle =
        new ContinuityBundlePackager(grants, skillVersions, licenses).assembleForUser("user1");

    // Two package refs (skillA deduped, skillD omitted), in first-seen order.
    assertThat(bundle.skillPackages())
        .extracting(SkillPackageRef::skillId)
        .containsExactly("skillA", "skillB");
    assertThat(bundle.skillPackages())
        .extracting(SkillPackageRef::packageSha256)
        .containsExactly("sha-a", "sha-b");

    // The pre-signed tokens carried verbatim.
    assertThat(bundle.licenseTokens()).containsExactly("token-A", "token-B");

    // The manifest binds the counts and id lists.
    ContinuityBundleManifest m = bundle.manifest();
    assertThat(m.userId()).isEqualTo("user1");
    assertThat(m.skillCount()).isEqualTo(2);
    assertThat(m.licenseCount()).isEqualTo(2);
    assertThat(m.skillIds()).containsExactly("skillA", "skillB");
    assertThat(m.licenseIds()).containsExactly("licA", "licB");
    assertThat(m.bundleId()).startsWith("cbundle_");
  }

  private static Grant active(String id, String userId, String skillId, GrantSource source) {
    return Grant.create(id, userId, skillId, source, "O-" + id, "mor", "USD", 500, Instant.now());
  }

  private static SkillVersion version(
      String skillId, String version, String uri, String sha, String signingKeyId) {
    SkillVersion v = new SkillVersion();
    v.setSkillId(skillId);
    v.setVersion(version);
    v.setPackageUri(uri);
    v.setPackageSha256(sha);
    v.setSigningKeyId(signingKeyId);
    v.setCurrent(true);
    return v;
  }

  private static License license(
      String id, String userId, String skillId, String deviceId, String token) {
    return License.active(id, userId, skillId, deviceId, "hp-lic-2026a", token, Instant.now());
  }
}
