package io.hydropark.continuity;

import java.util.List;

/**
 * A final continuity bundle (P1-23.2): everything a customer needs to keep running a set of owned
 * skills entirely offline, assembled server-side and handed to the client.
 *
 * <p>It is exactly three things:
 *
 * <ul>
 *   <li>{@link #manifest} - the self-describing header (owner, counts, id lists) the verifier checks
 *       the body against;
 *   <li>{@link #skillPackages} - references to the owned {@code .hpskill} packages (uri + sha256 +
 *       signing key), integrity-checked at install; and
 *   <li>{@link #licenseTokens} - the pre-signed license JWS strings minted by the P1-23.1 batch,
 *       re-verified against the trusted key set at install and <b>never re-signed</b>.
 * </ul>
 *
 * The bundle carries no private key and no signing capability - assembling and verifying it are pure
 * read/verify operations.
 */
public record ContinuityBundle(
    ContinuityBundleManifest manifest,
    List<SkillPackageRef> skillPackages,
    List<String> licenseTokens) {}
