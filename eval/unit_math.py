"""Deterministic unit conversion for the harness's full-system pass.

Mirrors the exact conversion factors in `client/web/src/app/tools/unit-math.ts`
and `client/src-tauri/src/tools.rs` (the internationally-defined avoirdupois /
US-legal constants). The app's `convert_units` tool does this arithmetic
deterministically — the model never does — which is exactly why PHASE0-PLAN §5
sets the "≥98% exact on unit conversions" floor: the deterministic layer gives
exactness for free. The harness computes it here to model the full-system pass
(and to cross-check the pre-written ground truth).
"""

from __future__ import annotations

_MASS_TO_G = {
    "g": 1.0,
    "kg": 1000.0,
    "oz": 28.349523125,   # international avoirdupois ounce
    "lb": 453.59237,      # international avoirdupois pound
}

_VOLUME_TO_ML = {
    "ml": 1.0,
    "l": 1000.0,
    "tsp": 4.92892159375,      # US legal teaspoon
    "tbsp": 14.78676478125,    # 3 tsp
    "fl_oz": 29.5735295625,    # US fluid ounce
    "cup": 236.5882365,        # US legal cup (8 US fl oz)
}


def _round6(n: float) -> float:
    return round(n * 1_000_000) / 1_000_000


def convert(spec: dict) -> float:
    """spec = {domain, value, from_unit, to_unit}. Returns the exact result."""
    domain = spec["domain"]
    value = float(spec["value"])
    frm = spec["from_unit"]
    to = spec["to_unit"]
    if domain == "mass":
        return _round6(value * _MASS_TO_G[frm] / _MASS_TO_G[to])
    if domain == "volume":
        return _round6(value * _VOLUME_TO_ML[frm] / _VOLUME_TO_ML[to])
    if domain == "temperature":
        if frm == to:
            return _round6(value)
        if frm == "c" and to == "f":
            return _round6(value * 9.0 / 5.0 + 32.0)
        if frm == "f" and to == "c":
            return _round6((value - 32.0) * 5.0 / 9.0)
        raise ValueError(f"unsupported temperature units {frm}->{to}")
    raise ValueError(f"unknown domain {domain}")
