package io.hydropark.continuity;

import java.time.Instant;
import java.util.List;

/**
 * The manifest of a continuity bundle (P1-23.2): the self-describing header the verifier checks the
 * bundle body against. It binds the bundle to a {@code userId}, records when it was {@link #assembledAt
 * assembled}, and pins both the <b>counts</b> and the <b>id lists</b> of what the bundle should
 * contain - {@link #skillIds} for the packaged skills and {@link #licenseIds} for the pre-signed
 * licenses.
 *
 * <p>Pinning ids (not just counts) is what lets the verifier detect a <em>substitution</em>, not only
 * an add/drop: a token swapped for one the manifest never listed, or a package ref quietly replaced,
 * fails the manifest cross-check even before its signature is examined.
 */
public record ContinuityBundleManifest(
    String bundleId,
    String userId,
    Instant assembledAt,
    int skillCount,
    int licenseCount,
    List<String> skillIds,
    List<String> licenseIds) {}
