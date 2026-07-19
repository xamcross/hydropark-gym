package io.hydropark.certification;

/**
 * A certified resource-cost figure for a skill manifest (P1-20.2, SPEC §8.3.5), returned by a
 * {@link BehavioralEvalPort}. Feeds the on-device capacity meter, which trusts this CERTIFIED figure
 * over the author's self-declared {@code cost_estimate}.
 *
 * @param promptTokens certified prompt-token contribution (persona + tool schemas + few-shot)
 * @param tools number of declared tools
 * @param panels number of declared panels
 * @param measured {@code true} iff produced by an actual behavioral-eval model run; {@code false} for
 *     a deterministic structural estimate (e.g. {@link DeclaredCostEstimateAdapter}). The capacity
 *     meter and UI use this to distinguish a real measurement from a placeholder upper bound.
 * @param method short identifier of how the figure was produced (e.g. {@code "behavioral_eval"} or
 *     {@code "structural_upper_bound"})
 */
public record CertifiedCostEstimate(
    int promptTokens, int tools, int panels, boolean measured, String method) {}
