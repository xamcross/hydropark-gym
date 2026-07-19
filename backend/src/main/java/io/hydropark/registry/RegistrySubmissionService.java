package io.hydropark.registry;

import com.fasterxml.jackson.databind.JsonNode;
import io.hydropark.certification.CertificationReport;
import io.hydropark.certification.CertificationService;
import io.hydropark.certification.Finding;
import io.hydropark.packaging.PackageSignatureException;
import io.hydropark.packaging.PackageSignatureVerifier;
import java.util.ArrayList;
import java.util.List;
import org.springframework.stereotype.Service;

/**
 * The registry submission gate (P1-19 / P1-20): ties package-signature verification to the
 * certification pipeline for a submitted skill manifest.
 *
 * <p>Order of operations, following the module's "complete report in one pass" contract:
 *
 * <ol>
 *   <li><b>Package signature (never skipped).</b> An invalid, tampered, missing, or unknown-kid
 *       signature becomes an explicit {@code ERROR} {@link Finding} in the report — the submission is
 *       never treated as certifiable just because the signature step failed to run.
 *   <li><b>Certification.</b> {@link CertificationService#certify} runs its full gate set (schema,
 *       referential, budget, styling, localization); its findings are appended.
 * </ol>
 *
 * <p>The combined {@link CertificationReport} passes iff there are zero ERROR findings across both
 * steps — so a signed-but-invalid manifest and a valid-but-unsigned manifest both fail.
 */
@Service
public class RegistrySubmissionService {

  private final PackageSignatureVerifier signatureVerifier;
  private final CertificationService certification;

  public RegistrySubmissionService(
      PackageSignatureVerifier signatureVerifier, CertificationService certification) {
    this.signatureVerifier = signatureVerifier;
    this.certification = certification;
  }

  public CertificationReport certifySubmission(JsonNode manifest) {
    List<Finding> findings = new ArrayList<>();

    // (a) Verify the package signature; a failure is an ERROR finding, never a skip.
    try {
      signatureVerifier.verify(manifest);
    } catch (PackageSignatureException e) {
      findings.add(
          Finding.error(e.code(), "package signature rejected: " + e.getMessage(), "/signature"));
    }

    // (b) Run the full certification gate and merge its findings.
    CertificationReport report = certification.certify(manifest);
    findings.addAll(report.findings());

    return new CertificationReport(report.skillId(), findings);
  }
}
