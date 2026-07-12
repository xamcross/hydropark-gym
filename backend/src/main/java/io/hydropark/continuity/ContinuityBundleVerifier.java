package io.hydropark.continuity;

import io.hydropark.licensing.LicensePayload;
import io.hydropark.licensing.LicenseVerificationException;
import io.hydropark.licensing.LicenseVerifier;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.springframework.stereotype.Component;

/**
 * The P1-23.2 continuity <b>verify + install</b> path. Given an assembled {@link ContinuityBundle} it
 * confirms the bundle is well-formed and every pre-signed license genuinely verifies, then returns the
 * {@link ContinuityBundleVerification installable set}. It is the mirror image of the packager and, by
 * construction, the opposite of the issuer: it holds a {@link LicenseVerifier} (public keys only) and
 * <b>no signer at all</b>. Verifying can never mint - there is no code path here that produces a
 * signature.
 *
 * <p>What it checks, each a hard rejection with a stable {@link ContinuityBundleException#code()}:
 *
 * <ol>
 *   <li><b>Manifest ↔ body counts</b> ({@code manifest_count_mismatch}): the declared skill/license
 *       counts equal the body sizes.
 *   <li><b>Package refs</b>: the packaged skill-id set matches the manifest ({@code
 *       package_set_mismatch}), and every ref carries its integrity anchors ({@code
 *       package_ref_incomplete}).
 *   <li><b>License signatures</b> ({@code license_signature_invalid}): every token verifies against
 *       the trusted key set - a tampered token is rejected here.
 *   <li><b>License binding</b>: each license is the bundle owner's ({@code license_wrong_owner}) and
 *       its {@code license_id} is one the manifest lists ({@code license_not_in_manifest}); the full
 *       set of listed ids must be present exactly ({@code license_set_mismatch}), so a dropped or
 *       duplicated token is caught.
 * </ol>
 */
@Component
public class ContinuityBundleVerifier {

  private final LicenseVerifier licenseVerifier;

  public ContinuityBundleVerifier(LicenseVerifier licenseVerifier) {
    this.licenseVerifier = licenseVerifier;
  }

  /**
   * Verify {@code bundle} end to end and return the installable set.
   *
   * @throws ContinuityBundleException on any inconsistency or tamper (see class doc for codes)
   */
  public ContinuityBundleVerification verify(ContinuityBundle bundle) {
    if (bundle == null || bundle.manifest() == null) {
      throw new ContinuityBundleException("bundle_missing", "bundle or manifest is absent");
    }
    ContinuityBundleManifest m = bundle.manifest();
    List<SkillPackageRef> packages = bundle.skillPackages() == null ? List.of() : bundle.skillPackages();
    List<String> tokens = bundle.licenseTokens() == null ? List.of() : bundle.licenseTokens();

    // (1) Manifest ↔ body counts.
    if (m.skillCount() != packages.size() || m.licenseCount() != tokens.size()) {
      throw new ContinuityBundleException(
          "manifest_count_mismatch",
          "manifest declares "
              + m.skillCount()
              + " skills / "
              + m.licenseCount()
              + " licenses but body has "
              + packages.size()
              + " / "
              + tokens.size());
    }

    // (2) Package refs: the set matches the manifest and every ref is install-complete.
    Set<String> manifestSkillIds = new HashSet<>(m.skillIds() == null ? List.of() : m.skillIds());
    Set<String> bodySkillIds = new HashSet<>();
    List<SkillPackageRef> installablePackages = new ArrayList<>();
    for (SkillPackageRef ref : packages) {
      if (isBlank(ref.skillId())
          || isBlank(ref.packageUri())
          || isBlank(ref.packageSha256())
          || isBlank(ref.signingKeyId())) {
        throw new ContinuityBundleException(
            "package_ref_incomplete",
            "package ref for skill '" + ref.skillId() + "' is missing uri/sha256/signing_key_id");
      }
      bodySkillIds.add(ref.skillId());
      installablePackages.add(ref);
    }
    if (!manifestSkillIds.equals(bodySkillIds)) {
      throw new ContinuityBundleException(
          "package_set_mismatch", "packaged skill ids do not match the manifest skill ids");
    }

    // (3) + (4) License signatures and binding. Every token must verify; NEVER re-signed.
    Set<String> manifestLicenseIds =
        new HashSet<>(m.licenseIds() == null ? List.of() : m.licenseIds());
    Set<String> seenLicenseIds = new HashSet<>();
    List<LicensePayload> installableLicenses = new ArrayList<>();
    for (String token : tokens) {
      LicensePayload payload;
      try {
        payload = licenseVerifier.verify(token);
      } catch (LicenseVerificationException bad) {
        throw new ContinuityBundleException(
            "license_signature_invalid", "a bundled license failed signature verification", bad);
      }
      if (!payload.sub().equals(m.userId())) {
        throw new ContinuityBundleException(
            "license_wrong_owner",
            "license " + payload.licenseId() + " is bound to a different user than the bundle owner");
      }
      if (!manifestLicenseIds.contains(payload.licenseId())) {
        throw new ContinuityBundleException(
            "license_not_in_manifest",
            "license " + payload.licenseId() + " is not listed in the bundle manifest");
      }
      seenLicenseIds.add(payload.licenseId());
      installableLicenses.add(payload);
    }
    if (!seenLicenseIds.equals(manifestLicenseIds)) {
      throw new ContinuityBundleException(
          "license_set_mismatch", "the bundled license ids do not match the manifest exactly");
    }

    return new ContinuityBundleVerification(
        m.userId(), List.copyOf(installablePackages), List.copyOf(installableLicenses));
  }

  private static boolean isBlank(String s) {
    return s == null || s.isBlank();
  }
}
