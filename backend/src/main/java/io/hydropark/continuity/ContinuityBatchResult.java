package io.hydropark.continuity;

import java.util.List;

/**
 * The outcome of running a dual-control continuity batch (P1-23.1).
 *
 * @param batchId the batch that ran
 * @param minted the number of licenses actually signed through the Issuer
 * @param skipped the number of (user, skill, device) targets the Issuer <b>refused</b> - a candidate
 *     grant whose order was not settled fails the keystone and is counted here, never signed
 * @param licenseIds the {@code license_id}s of the minted licenses
 */
public record ContinuityBatchResult(
    String batchId, int minted, int skipped, List<String> licenseIds) {}
