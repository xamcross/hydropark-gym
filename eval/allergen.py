"""Deterministic allergen-warning layer — Python side (P0-07.4, SPEC §28.1).

This is the H2 harness's view of the SAME deterministic, non-model allergen
layer the app ships. It does NOT define its own allergen map: it loads the ONE
canonical data file that the Rust app also embeds
(`client/src-tauri/src/skills/allergen/allergens.json`), so the harness provably
scores against the exact data the product ships. The map is never duplicated.

The word-boundary matcher below mirrors the std-only Rust matcher in
`client/src-tauri/src/skills/allergen/mod.rs` byte-for-byte in behaviour:
whole-word, case-insensitive, ASCII-alnum boundaries. That is why "egg" does not
fire on "eggplant" and "fish" does not fire on "shellfish".

SAFETY: this layer is never model-trusted and optimises RECALL over precision.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Iterable

# Relative path from this file (eval/) down into the app tree. The canonical
# data lives WITH THE APP because the allergen layer must ship inside the
# self-contained Rust core; the harness depends on the app, never the reverse.
_CANONICAL_REL = Path("client/src-tauri/src/skills/allergen/allergens.json")


def _find_canonical() -> Path:
    """Walk upward from eval/ to locate the repo root that holds the app tree."""
    here = Path(__file__).resolve()
    for base in [here.parent, *here.parents]:
        candidate = base / _CANONICAL_REL
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(
        f"could not locate canonical allergen data ({_CANONICAL_REL}); "
        "run the harness from within the Hydropark repo"
    )


@dataclass(frozen=True)
class AllergenFlag:
    allergen: str      # canonical key, e.g. "tree_nuts"
    display: str       # human label, e.g. "Tree nuts"
    matched_term: str  # the lowercased trigger term that fired


@lru_cache(maxsize=1)
def load_db() -> dict:
    with _find_canonical().open(encoding="utf-8") as fh:
        data = json.load(fh)
    # `_comment` is documentation only; ignore anything not part of the schema.
    return {
        "version": data["version"],
        "big9": list(data["big9"]),
        "allergens": data["allergens"],
    }


def canonical_path() -> Path:
    return _find_canonical()


def _is_word_char(ch: str) -> bool:
    return ch.isascii() and ch.isalnum()


def contains_word(haystack: str, needle: str) -> bool:
    """Whole-word, case-insensitive containment. Inputs must be pre-lowercased.

    `needle` may contain spaces (multi-word terms like "soy sauce").
    """
    if not needle:
        return False
    start = 0
    n = len(needle)
    hay_len = len(haystack)
    while True:
        i = haystack.find(needle, start)
        if i == -1:
            return False
        j = i + n
        left_ok = i == 0 or not _is_word_char(haystack[i - 1])
        right_ok = j == hay_len or not _is_word_char(haystack[j])
        if left_ok and right_ok:
            return True
        start = i + 1  # overlap-safe


def scan(text: str) -> list[AllergenFlag]:
    """Return every Big-9 allergen triggered by `text`. Deterministic, order-stable."""
    lower = text.lower()
    db = load_db()
    flags: list[AllergenFlag] = []
    for key in db["big9"]:
        entry = db["allergens"].get(key)
        if not entry:
            continue
        for term in entry["terms"]:
            if contains_word(lower, term.lower()):
                flags.append(AllergenFlag(key, entry["display"], term.lower()))
                break
    return flags


def flagged_allergens(text: str) -> set[str]:
    return {f.allergen for f in scan(text)}


def scan_ingredients(names: Iterable[str]) -> list[AllergenFlag]:
    return scan("\n".join(names))
