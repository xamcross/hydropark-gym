package io.hydropark.continuity;

/**
 * A reference to an owned {@code .hpskill} package inside a continuity bundle (P1-23.2). The bundle
 * carries the <em>reference</em> - the object-store {@code packageUri}, the {@code packageSha256}
 * integrity anchor, and the {@code signingKeyId} that signed the package - not the bytes themselves.
 * The {@code packageSha256} is what the install step checks the fetched/cached bytes against, and the
 * package's own Ed25519 signature (already verified at registry submission) is trusted per its
 * {@code signingKeyId}. The continuity verifier never re-signs a package; it verifies integrity.
 */
public record SkillPackageRef(
    String skillId,
    String version,
    String packageUri,
    String packageSha256,
    String signingKeyId) {}
