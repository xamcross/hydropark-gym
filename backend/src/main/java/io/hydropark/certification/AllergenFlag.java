package io.hydropark.certification;

/**
 * One Big-9 allergen triggered by the deterministic scanner (P1-20.4). Mirrors the harness's {@code
 * eval/allergen.py} {@code AllergenFlag}.
 *
 * @param allergen canonical Big-9 key, e.g. {@code "tree_nuts"}
 * @param display human label, e.g. {@code "Tree nuts"}
 * @param matchedTerm the lowercased trigger term that fired, e.g. {@code "marzipan"}
 */
public record AllergenFlag(String allergen, String display, String matchedTerm) {}
