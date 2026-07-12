package io.hydropark.continuity;

import io.hydropark.licensing.LicensePayload;
import java.util.List;

/**
 * The result of verifying a continuity bundle (P1-23.2): the <b>installable set</b> a well-formed
 * bundle yields. Produced only after every license JWS has verified and the manifest cross-checks
 * have passed, so the caller can install these directly.
 *
 * @param userId the bundle owner every license verified against
 * @param installablePackages the owned package refs to install (sha256-checked against fetched bytes)
 * @param installableLicenses the parsed, signature-verified license payloads to install
 */
public record ContinuityBundleVerification(
    String userId,
    List<SkillPackageRef> installablePackages,
    List<LicensePayload> installableLicenses) {}
