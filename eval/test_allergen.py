"""100%-coverage test for the deterministic allergen layer (P0-07.4 AC).

EXHAUSTIVE by construction: for EVERY allergen in the canonical map, and EVERY
trigger term of that allergen, assert the layer flags that allergen when the term
appears in realistic ingredient-line context. This is the literal "100%-coverage
test" the ticket requires. It is the runnable mirror of the `#[cfg(test)]` block
in `client/src-tauri/src/skills/allergen/mod.rs` (which cannot run here — no
`cargo` in this environment) and reads the SAME canonical `allergens.json`, so
proving it here proves the data the app ships.

Run:  python eval/test_allergen.py        (prints a coverage table + PASS/FAIL)
  or: python -m unittest eval.test_allergen
"""

from __future__ import annotations

import sys
import unittest

import allergen  # noqa: E402  (run from eval/ or with eval/ on the path)


def _run_coverage() -> tuple[int, list[str]]:
    """Return (pairs_checked, failures)."""
    db = allergen.load_db()
    failures: list[str] = []
    checked = 0
    for key, entry in db["allergens"].items():
        for term in entry["terms"]:
            text = f"2 cups of {term}, finely chopped"
            flags = allergen.flagged_allergens(text)
            if key not in flags:
                failures.append(f"{key!r} NOT flagged for its own term {term!r} (input: {text!r})")
            checked += 1
    return checked, failures


class AllergenCoverageTest(unittest.TestCase):
    def test_every_allergen_and_every_term_is_flagged(self):
        checked, failures = _run_coverage()
        self.assertGreater(checked, 0, "no terms checked — data failed to load")
        self.assertEqual(failures, [], f"{len(failures)} coverage gaps:\n" + "\n".join(failures))

    def test_required_hidden_aliases_resolve(self):
        self.assertIn("milk", allergen.flagged_allergens("sodium caseinate"))
        self.assertIn("eggs", allergen.flagged_allergens("dried albumin powder"))
        self.assertIn("sesame", allergen.flagged_allergens("a spoon of tahini"))
        self.assertIn("tree_nuts", allergen.flagged_allergens("marzipan filling"))
        self.assertIn("fish", allergen.flagged_allergens("worcestershire sauce"))
        self.assertIn("soy", allergen.flagged_allergens("edamame"))

    def test_whole_word_avoids_classic_false_matches(self):
        self.assertNotIn("eggs", allergen.flagged_allergens("grilled eggplant"))
        self.assertNotIn("fish", allergen.flagged_allergens("steamed shellfish"))

    def test_clean_text_flags_nothing(self):
        self.assertEqual(allergen.flagged_allergens("rice, water, salt, black pepper, olive oil"), set())


def main() -> int:
    db = allergen.load_db()
    print(f"Canonical data: {allergen.canonical_path()}")
    print(f"Schema version: {db['version']}   Big-9 allergens: {len(db['big9'])}\n")

    total_terms = 0
    print(f"{'allergen':<12} {'terms':>6}  coverage")
    print("-" * 34)
    all_ok = True
    for key, entry in db["allergens"].items():
        terms = entry["terms"]
        gaps = [t for t in terms if key not in allergen.flagged_allergens(f"2 cups of {t}, finely chopped")]
        ok = not gaps
        all_ok = all_ok and ok
        total_terms += len(terms)
        mark = "100%  OK" if ok else f"GAPS: {gaps}"
        print(f"{key:<12} {len(terms):>6}  {mark}")

    checked, failures = _run_coverage()
    print("-" * 34)
    print(f"\n(allergen, term) pairs checked: {checked}")
    pct = 100.0 * (checked - len(failures)) / checked if checked else 0.0
    print(f"coverage: {pct:.1f}%   ->   {'PASS (100% coverage floor met)' if all_ok and not failures else 'FAIL'}")

    # Sanity checks (aliases + no classic false positives) reported inline.
    checks = {
        "casein->milk": "milk" in allergen.flagged_allergens("sodium caseinate"),
        "albumin->eggs": "eggs" in allergen.flagged_allergens("dried albumin"),
        "tahini->sesame": "sesame" in allergen.flagged_allergens("tahini"),
        "eggplant NOT eggs": "eggs" not in allergen.flagged_allergens("grilled eggplant"),
        "shellfish NOT fish": "fish" not in allergen.flagged_allergens("steamed shellfish"),
        "clean text -> none": allergen.flagged_allergens("rice, water, salt") == set(),
    }
    print("\nsanity checks:")
    for name, ok in checks.items():
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}")
        all_ok = all_ok and ok

    return 0 if (all_ok and not failures) else 1


if __name__ == "__main__":
    sys.exit(main())
